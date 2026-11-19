const { Client, logger, Variables } = require('camunda-external-task-client-js');
const sqlite3 = require('sqlite3').verbose();
const { Server } = require('socket.io');
const express = require('express');
const cors = require('cors');
const http = require('http');
const axios = require('axios');
const { createObjectCsvWriter } = require('csv-writer');

const app = express();
app.use(cors());
app.use(express.json());

const BILL_INSTITUTIONS = {
    'Su': { name: 'İSKİ', mockName: 'iski' },
    'Elektrik': { name: 'TEDAŞ', mockName: 'tedas' },
    'Doğalgaz': { name: 'İGDAŞ', mockName: 'igdas' },
    'İnternet': { name: 'Türk Telekom', mockName: 'turktelekom' }
};

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const db = new sqlite3.Database('./bank.db', (err) => {
    if (err) console.error('Veritabanına bağlanılamadı:', err.message);
    else {
        db.configure('busyTimeout', 5000); 
        db.run('PRAGMA journal_mode = WAL;');
        db.run(
            `INSERT INTO Accounts
             (customer_id, iban, balance, customer_type, account_number, account_type, currency)
             SELECT ?, ?, 0, 'BANK', ?, 'FATURA_HAVUZ', 'TRY'
             WHERE NOT EXISTS (
                 SELECT 1 FROM Accounts WHERE account_number = 'FATURA-HAVUZ-001'
             )`,
            ['BANK_FATURA_HAVUZ', 'TR999999999999999999999901', 'FATURA-HAVUZ-001'],
            (poolErr) => {
                if (poolErr) console.error('Fatura havuz hesabı oluşturulamadı:', poolErr.message);
                else console.log('🏦 [FATURA HAVUZU] Hesap hazır: FATURA-HAVUZ-001');
            }
        );
        db.run(`
            CREATE TABLE IF NOT EXISTS bill_pool_ledger (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                process_id TEXT,
                source_account TEXT,
                amount REAL NOT NULL CHECK (amount > 0),
                direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
                transaction_id TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(process_id, direction)
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS payment_instructions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id TEXT NOT NULL,
                account_number TEXT NOT NULL,
                title TEXT,
                institution_name TEXT NOT NULL,
                subscriber_number TEXT NOT NULL,
                funding_source TEXT NOT NULL DEFAULT 'wallet'
                    CHECK (funding_source IN ('wallet', 'card')),
                max_amount REAL
                    CHECK (max_amount IS NULL OR max_amount > 0),
                payment_day INTEGER
                    CHECK (payment_day BETWEEN 1 AND 31),
                is_active INTEGER NOT NULL DEFAULT 1
                    CHECK (is_active IN (0, 1)),
                last_payment_status TEXT,
                next_payment_date TEXT,
                last_payment_date TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `, (tableErr) => {
            if (tableErr) console.error('payment_instructions tablosu oluşturulamadı:', tableErr.message);
            else console.log('✅ payment_instructions tablosu hazır.');
        });
        db.run(`
            CREATE INDEX IF NOT EXISTS idx_payment_instructions_due
            ON payment_instructions (is_active, next_payment_date)
        `);
        db.run(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_active_payment_instruction
            ON payment_instructions (
                customer_id,
                account_number,
                institution_name,
                subscriber_number
            )
            WHERE is_active = 1
        `);
        db.all(`PRAGMA table_info(payment_instructions)`, (pragmaErr, columns) => {
            if (pragmaErr) return console.error('payment_instructions şeması okunamadı:', pragmaErr.message);
            if (!columns.some((column) => column.name === 'title')) {
                db.run(`ALTER TABLE payment_instructions ADD COLUMN title TEXT`, (alterErr) => {
                    if (alterErr) console.error('payment_instructions title sütunu eklenemedi:', alterErr.message);
                    else console.log('✅ payment_instructions title sütunu eklendi.');
                });
            }
        });
    }
});

const getIsOutOfHours = () => {
    const currentHour = new Date().getHours();
    return currentHour >= 17 || currentHour < 9;
};

// REST API Uç Noktası (Cüzdan verilerini çekme)
app.get('/api/wallet/:customerId', (req, res) => {
    const customerId = req.params.customerId;
    
    // 1. Müşteriye ait TÜM hesapları çek
    db.all(`SELECT id, account_type, account_number, balance, currency, swift_code, iban, total_loyalty_points, customer_type, days_to_maturity FROM Accounts WHERE customer_id = ?`, [customerId], (err, accountsList) => {
        if (err || !accountsList || accountsList.length === 0) return res.status(404).json({ error: "Hesap bulunamadı" });
        
        // Müşterinin tüm IBAN'larını bir diziye (array) alıyoruz
        const ibans = accountsList.map(a => a.iban);
        const placeholders = ibans.map(() => '?').join(',');
        
        // 2. Bu IBAN'lardan HERHANGİ BİRİNİN geçtiği TÜM işlemleri getir
        db.all(`SELECT * FROM Transactions WHERE sender_iban IN (${placeholders}) OR receiver_iban IN (${placeholders}) ORDER BY id DESC`, [...ibans, ...ibans], (err, transactions) => {
            
            // Dashboard Ana Bakiyesini tüm hesapların toplamı olarak göstermek için:
            const totalBalance = accountsList.reduce((sum, acc) => sum + (Number(acc.balance) || 0), 0);
            
            const mainAccount = accountsList[0];

            res.json({ 
                balance: totalBalance, // Toplam Cüzdan Bakiyesi
                loyaltyPoints: mainAccount.total_loyalty_points || 0,
                customerType: mainAccount.customer_type || 'STANDART',
                transactions: transactions || [],
                accounts: accountsList || [] 
            });
        });
    });
});

// --- DIŞ TRANSFER BAŞLATMA (Havale/EFT) ---
app.post('/api/external-transfer', (req, res) => {
    const { customerId, fromAccountNumber, receiver, amount, paymentType, paymentDescription, transactionDate } = req.body;
    const numericAmount = parseFloat(amount); 

    db.get(`SELECT account_type, customer_type, iban, currency FROM Accounts WHERE customer_id = ? AND account_number = ?`, [customerId, fromAccountNumber], async (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Gönderici hesabı bulunamadı" });

        try {
            const camundaResponse = await axios.post('http://localhost:8081/engine-rest/process-definition/key/MoneyTransferProcess/start', {
                variables: {
                    isOutOfHours: { value: getIsOutOfHours(), type: "Boolean" },
                    senderId: { value: customerId, type: "String" },
                    senderIban: { value: row.iban, type: "String" },
                    recipientIban: { value: receiver, type: "String" },
                    amount: { value: numericAmount, type: "Double" },
                    customerType: { value: row.customer_type || "STANDART", type: "String" },
                    paymentType: { value: paymentType || "Diğer", type: "String" }, 
                    paymentDescription: { value: paymentDescription || "", type: "String" }, 
                    transactionDate: { value: transactionDate || new Date().toISOString(), type: "String" },

                    senderAccountType: { value: row.account_type, type: "String" },
                    senderCurrency: { value: row.currency || "TRY", type: "String" },
                    receiverCurrency: { value: "TRY", type: "String" }, 
                    isInterestLossAccepted: { value: false, type: "Boolean" }
                }
            });
            res.status(200).json({ success: true, processInstanceId: camundaResponse.data.id, message: `Dış transfer süreci başlatıldı.` });
        } catch (error) {
            console.error("Camunda başlatma hatası:", error.response?.data || error.message);
            res.status(500).json({ error: "Transfer başlatılamadı" });
        }
    });
});

// --- HESAPLARIM ARASI TRANSFER (İç Transfer) ---
app.post('/api/internal-transfer', async (req, res) => {
    const { customerId, fromAccountNumber, toAccountNumber, amount, paymentDescription, transactionDate } = req.body;
    const numericAmount = parseFloat(amount);

    db.all(`SELECT account_number, account_type, currency FROM Accounts WHERE customer_id = ? AND account_number IN (?, ?)`, [customerId, fromAccountNumber, toAccountNumber], async (err, rows) => {
        if (err || !rows || rows.length < 2) return res.status(404).json({ error: "Hesaplar bulunamadı" });
        
        const senderAcc = rows.find(r => r.account_number === fromAccountNumber);
        const receiverAcc = rows.find(r => r.account_number === toAccountNumber);

        try {
            const camundaResponse = await axios.post('http://localhost:8081/engine-rest/process-definition/key/InternalTransferProcess/start', {
                variables: {
                    customerId: { value: customerId, type: "String" },
                    fromAccountNumber: { value: fromAccountNumber, type: "String" },
                    toAccountNumber: { value: toAccountNumber, type: "String" },
                    amount: { value: numericAmount, type: "Double" },
                    paymentDescription: { value: paymentDescription || "", type: "String" },
                    transactionDate: { value: transactionDate || new Date().toISOString(), type: "String" },
                    isOutOfHours: { value: getIsOutOfHours(), type: "Boolean" },
                    
                    senderAccountType: { value: senderAcc.account_type, type: "String" },
                    senderCurrency: { value: senderAcc.currency || "TRY", type: "String" },
                    receiverCurrency: { value: receiverAcc.currency || "TRY", type: "String" }
                }
            });
            res.status(200).json({ success: true, processInstanceId: camundaResponse.data.id, message: "Hesaplarım arası transfer süreci başlatıldı." });
        } catch (error) {
            console.error("Camunda iç transfer başlatma hatası:", error.response?.data || error.message);
            res.status(500).json({ error: "Transfer başlatılamadı" });
        }
    });
});

// --- SWIFT (Uluslararası) TRANSFER BAŞLATMA ---
app.post('/api/swift-transfer', (req, res) => {
    const { customerId, fromAccountNumber, receiverIban, receiverName, swiftCode, currency, expenseType, purpose, amount, paymentDescription, transactionDate } = req.body;
    const numericAmount = parseFloat(amount); 

    db.get(`SELECT account_type, customer_type, iban, currency FROM Accounts WHERE customer_id = ? AND account_number = ?`, [customerId, fromAccountNumber], async (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Gönderici hesabı bulunamadı" });

        try {
            const camundaResponse = await axios.post('http://localhost:8081/engine-rest/process-definition/key/SwiftTransferProcess/start', {
                variables: {
                    senderId: { value: customerId, type: "String" },
                    senderIban: { value: row.iban, type: "String" },
                    recipientIban: { value: receiverIban, type: "String" },
                    amount: { value: numericAmount, type: "Double" },
                    customerType: { value: row.customer_type || "STANDART", type: "String" },
                    paymentType: { value: "SWIFT", type: "String" }, 
                    paymentDescription: { value: paymentDescription || "", type: "String" }, 
                    transactionDate: { value: transactionDate || new Date().toISOString(), type: "String" },
                    
                    swiftCode: { value: swiftCode, type: "String" },
                    currency: { value: currency, type: "String" },
                    expenseType: { value: expenseType, type: "String" },
                    transferPurpose: { value: purpose, type: "String" },

                    senderAccountType: { value: row.account_type, type: "String" },
                    senderCurrency: { value: row.currency || "TRY", type: "String" },
                    receiverCurrency: { value: currency, type: "String" }
                }
            });
            res.status(200).json({ success: true, processInstanceId: camundaResponse.data.id, message: `SWIFT süreci başlatıldı.` });
        } catch (error) {
            console.error("Camunda SWIFT başlatma hatası:", error.response?.data || error.message);
            res.status(500).json({ error: "Camunda SWIFT süreci bulunamadı." });
        }
    });
});

// --- YENİ HESAP AÇILIŞ SÜRECİ BAŞLATMA ---
app.post('/api/open-account', (req, res) => {
    const { customerId, sourceAccountNumber, senderAccountType, senderCurrency, receiverAccountType, receiverCurrency, amount, daysToMaturity, isCurrencyConverted, isAccountExpired } = req.body;
    
    db.get(`SELECT iban, customer_type FROM Accounts WHERE customer_id = ? AND account_number = ?`, [customerId, sourceAccountNumber], async (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Gönderici hesabı bulunamadı" });

        try {
            const camundaResponse = await axios.post('http://localhost:8081/engine-rest/process-definition/key/vadeliParaTransferi/start', {
                variables: {
                    senderId: { value: customerId, type: "String" },
                    fromAccountNumber: { value: sourceAccountNumber, type: "String" },
                    amount: { value: parseFloat(amount), type: "Double" },
                    senderIban: { value: row.iban, type: "String" }, 
                    recipientIban: { value: "YENİ HESAP", type: "String" }, 
                    customerType: { value: row.customer_type || "STANDART", type: "String" }, 
                    paymentType: { value: "Hesap Açılışı", type: "String" }, 
                    paymentDescription: { value: "İlk Bakiye Aktarımı", type: "String" },
                    transactionDate: { value: new Date().toISOString(), type: "String" },
                    
                    daysToMaturity: { value: parseInt(daysToMaturity) || 0, type: "Integer" },
                    isOutOfHours: { value: getIsOutOfHours(), type: "Boolean" },
                    
                    senderAccountType: { value: senderAccountType, type: "String" },
                    receiverAccountType: { value: receiverAccountType, type: "String" },
                    senderCurrency: { value: senderCurrency, type: "String" },
                    receiverCurrency: { value: receiverCurrency, type: "String" },
                    isCurrencyConverted: { value: isCurrencyConverted, type: "Boolean" },
                    isAccountExpired: { value: isAccountExpired || false, type: "Boolean" },
                    isInterestLossAccepted: { value: false, type: "Boolean" }
                }
            });
            res.status(200).json({ success: true, processInstanceId: camundaResponse.data.id });
        } catch (error) {
            console.error("Hesap açma süreci başlatılamadı:", error.response?.data?.message || error.message);
            res.status(500).json({ error: "Süreç başlatılamadı" });
        }
    });
});

io.on('connection', (socket) => {
    console.log('📱 React Native istemcisi bağlandı. Socket ID:', socket.id);
});

server.listen(3000, () => {
    console.log('🔌 API ve WebSocket sunucusu 3000 portunda dinliyor.');
});

// =======================================================================
// MOCK API - İSKİ FATURA SORGULAMA
// =======================================================================
const createInstitutionInquiry = (mockName, aboneNo) => {
    const institution = Object.values(BILL_INSTITUTIONS).find((item) => item.mockName === mockName)
        || BILL_INSTITUTIONS['Su'];
    const randomTutar = (Math.random() * 400 + 100).toFixed(2);
    const referansNo = `REF-${institution.mockName.toUpperCase()}-${Math.floor(Math.random() * 1000000)}`;

    if (aboneNo === '9999') {
        return {
            aboneNo,
            kurum: institution.name,
            isim: "AH*** AK***",
            tutar: 0,
            sonOdemeTarihi: "2026-11-10",
            durum: "Ödendi",
            faturaReferansNo: referansNo
        };
    }

    return {
        aboneNo,
        kurum: institution.name,
        isim: "AH*** AK***",
        tutar: parseFloat(randomTutar),
        sonOdemeTarihi: "2026-11-25",
        durum: "Ödenmedi",
        faturaReferansNo: referansNo
    };
};

app.get('/mock-api/bill-institutions/:institution/inquiry/:aboneNo', (req, res) => {
    const mockName = req.params.institution;
    const aboneNo = req.params.aboneNo;
    const institution = Object.values(BILL_INSTITUTIONS).find((item) => item.mockName === mockName);
    if (!institution) {
        return res.status(404).json({ error: 'Bilinmeyen kuruma ait mock API' });
    }
    console.log(`\n🌐 [MOCK ${institution.name.toUpperCase()} API] ${aboneNo} numaralı abone için sorgu alındı...`);
    res.json(createInstitutionInquiry(mockName, aboneNo));
});

app.get('/mock-api/iski/inquiry/:aboneNo', (req, res) => {
    const aboneNo = req.params.aboneNo;

    // Fatura tutarını 100 ile 500 TL arası rastgele (dinamik) üretelim
    const randomTutar = (Math.random() * 400 + 100).toFixed(2);
    const referansNo = 'REF-' + Math.floor(Math.random() * 1000000);

    console.log(`\n🌐 [MOCK İSKİ API] ${aboneNo} numaralı abone için sorgu alındı...`);

    // TEST SENARYOSU 1: Abone numarası "9999" ise DMN tablosunu test etmek için "Ödenmiş" fatura dön.
    if (aboneNo === '9999') {
        return res.json({
            aboneNo: aboneNo,
            isim: "AH*** AK***",
            tutar: 0,
            sonOdemeTarihi: "2026-11-10",
            durum: "Ödendi", // DMN bu statüyü görünce reddetmeli!
            faturaReferansNo: referansNo
        });
    }

    // TEST SENARYOSU 2: Normal (Ödenmemiş) Fatura
    res.json({
        aboneNo: aboneNo,
        isim: "AH*** AK***",
        tutar: parseFloat(randomTutar),
        sonOdemeTarihi: "2026-11-25",
        durum: "Ödenmedi", // DMN bu statüyü görünce onaylamalı!
        faturaReferansNo: referansNo
    });
});

// =======================================================================
// YENİ! MOCK API - İSKİ GÜN SONU (EOD) MUTABAKATI
// =======================================================================
const handleInstitutionSettlement = (req, res, mockName) => {
    const institution = Object.values(BILL_INSTITUTIONS).find((item) => item.mockName === mockName)
        || BILL_INSTITUTIONS['Su'];
    console.log(`\n🌐 [MOCK ${institution.name.toUpperCase()} API] Gün Sonu Mutabakat CSV verisi ulaştı.`);
    const transactions = Array.isArray(req.body.transactions) ? req.body.transactions : [];
    const mode = (process.env.MOCK_ISKI_MODE || 'approved').toLowerCase();

    if (mode === 'timeout') {
        console.log(`🔧 [TEST MODU] API cevap vermiyor (zaman aşımı simülasyonu)...`);
        return;
    }

    if (!['approved', 'rejected', 'partial'].includes(mode)) {
        return res.status(400).json({
            error: "Geçersiz MOCK_ISKI_MODE. approved, rejected, partial veya timeout kullanın."
        });
    }

    const results = transactions.map((trx, index) => {
        const isApproved = mode === 'approved' || (mode === 'partial' && index % 2 === 0);
        return {
            transaction_id: trx.transaction_id,
            bill_reference_no: trx.bill_reference_no,
            subscriber_number: trx.subscriber_number,
            status: isApproved ? 'APPROVED' : 'REJECTED',
            reason: isApproved ? 'Mutabakat sağlandı.' : 'Fatura bulunamadı veya kurumda önceden ödenmiş.'
        };
    });

    setTimeout(() => {
        res.json({
            settlementDate: new Date().toISOString(),
            totalProcessed: results.length,
            results
        });
        console.log(`🌐 [MOCK ${institution.name.toUpperCase()} API] Mutabakat sonuçları bankaya gönderildi. Mod: ${mode}`);
    }, 1000);
};

app.post('/mock-api/iski/eod-settlement', (req, res) => {
    handleInstitutionSettlement(req, res, 'iski');
});

app.post('/mock-api/bill-institutions/:institution/eod-settlement', (req, res) => {
    handleInstitutionSettlement(req, res, req.params.institution);
});

// --- FATURA ÖDEME SÜRECİ BAŞLATMA ---
app.get('/api/payment-instructions/:customerId', (req, res) => {
    db.all(
        `SELECT * FROM payment_instructions
         WHERE customer_id = ?
         ORDER BY is_active DESC, next_payment_date ASC, id DESC`,
        [req.params.customerId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'Talimatlar okunamadı' });
            res.json({ instructions: rows || [] });
        }
    );
});

app.post('/api/payment-instructions', (req, res) => {
    const {
        customerId,
        accountNumber,
        title,
        institutionName,
        subscriberNumber,
        fundingSource,
        maxAmount,
        paymentDay
    } = req.body;

    if (!customerId || !accountNumber || !institutionName || !subscriberNumber) {
        return res.status(400).json({ error: 'Talimat bilgileri eksik' });
    }

    axios.post('http://localhost:8081/engine-rest/process-definition/key/Process_0pwuer6/start', {
        variables: {
            customerId: { value: customerId, type: 'String' },
            accountNumber: { value: accountNumber, type: 'String' },
            title: { value: title || `${institutionName} Talimatı`, type: 'String' },
            institutionName: { value: institutionName, type: 'String' },
            subscriberNumber: { value: subscriberNumber.trim(), type: 'String' },
            fundingSource: { value: fundingSource || 'wallet', type: 'String' },
            maxAmount: { value: maxAmount === null || maxAmount === '' ? '' : String(maxAmount), type: 'String' },
            paymentDay: { value: paymentDay === null || paymentDay === '' ? '' : String(paymentDay), type: 'String' }
        }
    }).then((camundaResponse) => {
        res.status(202).json({
            success: true,
            processInstanceId: camundaResponse.data.id,
            message: 'Talimat oluşturma süreci Camunda tarafından başlatıldı.'
        });
    }).catch((error) => {
        console.error('Camunda talimat süreci başlatma hatası:', error.response?.data || error.message);
        res.status(500).json({ error: 'Talimat süreci başlatılamadı' });
    });
});

app.patch('/api/payment-instructions/:id', (req, res) => {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'is_active değeri geçersiz' });
    }

    db.run(
        `UPDATE payment_instructions
         SET is_active = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [isActive ? 1 : 0, req.params.id],
        function (err) {
            if (err) return res.status(500).json({ error: 'Talimat güncellenemedi' });
            if (this.changes !== 1) return res.status(404).json({ error: 'Talimat bulunamadı' });
            res.json({ success: true });
        }
    );
});

app.post('/api/pay-bill', (req, res) => {
    const { customerId, accountNumber, subscriberNumber, category } = req.body;

    if (!customerId || !accountNumber || !subscriberNumber || !category) {
        return res.status(400).json({ error: "Fatura ödeme bilgileri eksik" });
    }
    const institution = BILL_INSTITUTIONS[category];
    if (!institution) {
        return res.status(400).json({ error: "Geçersiz fatura kategorisi" });
    }

    db.get(`SELECT balance, iban, customer_type FROM Accounts WHERE customer_id = ? AND account_number = ?`, 
    [customerId, accountNumber], async (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Ödeme yapılacak hesap bulunamadı" });

        try {
            const camundaResponse = await axios.post('http://localhost:8081/engine-rest/process-definition/key/Process_1gmhbt4/start', {
                variables: {
                    aboneNo: { value: subscriberNumber, type: "String" }, 
                    payerAccount: { value: accountNumber, type: "String" }, 
                    Balance: { value: parseFloat(row.balance), type: "Double" }, 
                    customerType: { value: row.customer_type || "STANDART", type: "String" },
                    institutionName: { value: institution.name, type: "String" }, 
                    limitAsimiVarMi: { value: false, type: "Boolean" },
                    kurumAPIAktifMi: { value: true, type: "Boolean" }
                }
            });
            res.status(200).json({ success: true, processInstanceId: camundaResponse.data.id, message: "Fatura ödeme süreci başlatıldı." });
        } catch (error) {
            console.error("Camunda fatura başlatma hatası:", error.response?.data || error.message);
            res.status(500).json({ error: "Fatura süreci başlatılamadı" });
        }
    });
});

// 2. Camunda Ayarları
const config = { baseUrl: 'http://localhost:8081/engine-rest', use: logger, asyncResponseTimeout: 10000 };
const client = new Client(config);
console.log("⚙️ Camunda Worker Başladı... İşler bekleniyor.");

const safeComplete = async (taskService, task, variables) => {
    try {
        if (variables) await taskService.complete(task, variables);
        else await taskService.complete(task);
    } catch (e) {
        console.error(`\n🔥 [KRİTİK HATA] Camunda Görev Tamamlama Başarısız! Detay: ${e.message}`);
    }
};

const safeFailure = async (taskService, task, errorMessage) => {
    try {
        await taskService.handleFailure(task, { errorMessage });
    } catch (e) {
        console.error(`\n🔥 [KRİTİK HATA] Görev Başarısızlığı Bildirilemedi: ${e.message}`);
    }
};

const safeBpmnError = async (taskService, task, errorCode, errorMessage) => {
    try {
        await taskService.handleBpmnError(task, errorCode, errorMessage);
    } catch (e) {
        console.error(`\n🔥 [KRİTİK HATA] BPMN Hatası Fırlatılamadı: ${e.message}`);
    }
};

const parsePositiveAmount = (value) => {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 ? amount : null;
};

// --- OTOMATİK FATURA ÖDEME TALİMATI: CAMUNDA SERVICE TASK'LARI ---
client.subscribe('veritabanina-talimat ekle', async ({ task, taskService }) => {
    const customerId = task.variables.get('customerId');
    const accountNumber = task.variables.get('accountNumber');
    const title = task.variables.get('title');
    const institutionVariable = task.variables.get('institutionName');
    const institutionName = BILL_INSTITUTIONS[institutionVariable]?.name || institutionVariable;
    const subscriberNumber = task.variables.get('subscriberNumber');
    const fundingSource = task.variables.get('fundingSource') || 'wallet';
    const maxAmountValue = task.variables.get('maxAmount');
    const paymentDayValue = task.variables.get('paymentDay');

    if (!customerId || !accountNumber || !institutionName || !subscriberNumber) {
        return await safeFailure(taskService, task, 'Talimat bilgileri eksik');
    }

    if (!['wallet', 'card'].includes(fundingSource)) {
        return await safeFailure(taskService, task, 'Geçersiz ödeme kaynağı');
    }

    const maxAmount = maxAmountValue === null || maxAmountValue === '' ? null : Number(maxAmountValue);
    if (maxAmount !== null && (!Number.isFinite(maxAmount) || maxAmount <= 0)) {
        return await safeFailure(taskService, task, 'Geçersiz maksimum tutar');
    }

    const paymentDay = paymentDayValue === null || paymentDayValue === '' ? null : parseInt(paymentDayValue, 10);
    if (paymentDay !== null && (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31)) {
        return await safeFailure(taskService, task, 'Geçersiz ödeme günü');
    }

    db.get(
        `SELECT account_number FROM Accounts
         WHERE customer_id = ? AND account_number = ?`,
        [customerId, accountNumber],
        async (accountErr, account) => {
            if (accountErr) return await safeFailure(taskService, task, 'Hesap doğrulanamadı');
            if (!account) return await safeFailure(taskService, task, 'Ödeme hesabı bulunamadı');

            let nextPaymentDate = null;
            if (paymentDay !== null) {
                const now = new Date();
                const candidate = new Date(now.getFullYear(), now.getMonth(), paymentDay);
                if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
                    candidate.setMonth(candidate.getMonth() + 1);
                }
                const localDate = new Date(candidate.getTime() - (candidate.getTimezoneOffset() * 60000));
                nextPaymentDate = localDate.toISOString().split('T')[0];
            }

            db.run(
                `INSERT INTO payment_instructions (
                    customer_id, account_number, title, institution_name, subscriber_number,
                    funding_source, max_amount, payment_day, is_active, next_payment_date
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
                [
                    customerId,
                    accountNumber,
                    title || `${institutionName} Talimatı`,
                    institutionName,
                    subscriberNumber.trim(),
                    fundingSource,
                    maxAmount,
                    paymentDay,
                    nextPaymentDate
                ],
                async function (insertErr) {
                    if (insertErr) {
                        const message = String(insertErr.message).includes('uq_active_payment_instruction')
                            ? 'Bu abonelik için aktif bir talimat zaten var'
                            : 'Talimat kaydedilemedi';
                        return await safeFailure(taskService, task, message);
                    }

                    const processVariables = new Variables();
                    processVariables.set('paymentInstructionId', this.lastID);
                    await safeComplete(taskService, task, processVariables);
                }
            );
        }
    );
});

client.subscribe('talimat-olusturuldu-mesaji', async ({ task, taskService }) => {
    const customerId = task.variables.get('customerId');
    const subscriberNumber = task.variables.get('subscriberNumber');
    const instructionId = task.variables.get('paymentInstructionId');

    console.log(`\n📣 [TALİMAT OLUŞTURULDU] Müşteri: ${customerId} | Abone: ${subscriberNumber} | Talimat ID: ${instructionId}`);
    io.emit('payment-instruction-created', {
        instructionId,
        customerId,
        subscriberNumber,
        message: 'Otomatik ödeme talimatı oluşturuldu.'
    });
    await safeComplete(taskService, task);
});

// --- GÖREV 1: Bakiye Kontrolü ve Parayı Askıya Alma (Provizyon) ---
client.subscribe('check-balance-aml', async ({ task, taskService }) => {
    const amount = parsePositiveAmount(task.variables.get('amount'));
    const senderIban = task.variables.get('senderIban'); 
    const recipientIban = task.variables.get('recipientIban');
    
    const paymentType = task.variables.get('paymentType');
    const paymentDescription = task.variables.get('paymentDescription');
    const transactionDate = task.variables.get('transactionDate');
    
    const transferPurpose = task.variables.get('transferPurpose') || null;
    const expenseType = task.variables.get('expenseType') || null;

    const processId = task.processInstanceId;
    const feeAmount = Number(task.variables.get('feeAmount')) || 0;
    const customerType = task.variables.get('customerType');
    const totalDeduction = amount === null || feeAmount < 0 ? null : amount + feeAmount;

    console.log(`\n💰 [BAKİYE KONTROLÜ] Müşteri: ${customerType} | Transfer: ${amount} | Tür: ${paymentType}`);

    if (totalDeduction === null) {
        return await safeFailure(taskService, task, "Geçersiz transfer tutarı");
    }

    db.run(`UPDATE Accounts SET balance = balance - ? WHERE iban = ? AND balance >= ?`,
        [totalDeduction, senderIban, totalDeduction], async function (err) {
        if (!err && this.changes === 1) {
            console.log(`✅ [KONTROL BAŞARILI] Bakiyeden anında ${totalDeduction} düşülüyor...`);
            
            db.run(`INSERT INTO Transactions (sender_iban, receiver_iban, amount, fee_amount, loyalty_points, status, camunda_process_id, payment_type, payment_description, transaction_date, transfer_purpose, expense_type) 
                    VALUES (?, ?, ?, ?, 0, 'PENDING', ?, ?, ?, ?, ?, ?)`, 
            [senderIban, recipientIban, amount, feeAmount, processId, paymentType, paymentDescription, transactionDate, transferPurpose, expenseType], async (insertErr) => {
                if (insertErr) return await safeFailure(taskService, task, "Transfer kaydı oluşturulamadı");
                const processVariables = new Variables();
                processVariables.set('totalDeduction', totalDeduction);
                await safeComplete(taskService, task, processVariables);
            });
        } else {
            console.log(`\n❌ [KONTROL BAŞARISIZ] Gönderici yetersiz bakiye!`);
            await safeFailure(taskService, task, err ? "Bakiye kontrolü başarısız" : "Yetersiz bakiye");
        }
    });
});

// --- GÖREV 2: Transfer Onaylandığında (Para Alıcıya Geçer) ---
client.subscribe('execute-transfer', async ({ task, taskService }) => {
    const amount = parsePositiveAmount(task.variables.get('amount'));
    const recipientIdentifier = task.variables.get('recipientIban'); 
    const processId = task.processInstanceId;

    console.log(`\n💸 [TRANSFER ONAYLANDI] Para alıcıya aktarılıyor ve işlem tamamlanıyor...`);

    if (amount === null) return await safeFailure(taskService, task, "Geçersiz transfer tutarı");

    db.run(`UPDATE Accounts SET balance = balance + ? WHERE iban = ? OR account_number = ? OR account_phone = ?`, 
    [amount, recipientIdentifier, recipientIdentifier, recipientIdentifier], function (err) {
        if (err || this.changes !== 1) {
            return safeFailure(taskService, task, "Alıcı hesabı bulunamadı");
        }

        db.run(`UPDATE Transactions SET status = 'COMPLETED' WHERE camunda_process_id = ?`, [processId], async (transactionErr) => {
            if (transactionErr) return await safeFailure(taskService, task, "Transfer durumu güncellenemedi");
            io.emit('transfer-approved', { amount: amount, message: 'İşlem onaylandı.' });
            await safeComplete(taskService, task);
        });
    });
});

// --- GÖREV 3: Zaman Aşımı / İptal Durumu ---
client.subscribe('transfer-timeout', async ({ task, taskService }) => {
    const amount = parseFloat(task.variables.get('amount'));
    const feeAmount = parseFloat(task.variables.get('feeAmount')) || 0;
    const totalDeduction = parseFloat(task.variables.get('totalDeduction')) || (amount + feeAmount); 

    const senderIban = task.variables.get('senderIban'); 
    const processId = task.processInstanceId;
    const rejectionReason = task.variables.get('rejectionReason') || "Zaman Aşımı / İptal";

    console.log(`⏰ [İPTAL DURUMU] ${totalDeduction} birim iade ediliyor. Sebep: ${rejectionReason}`);

    db.serialize(async () => {
        db.run(`UPDATE Accounts SET balance = balance + ? WHERE iban = ?`, [totalDeduction, senderIban]);
        db.run(`UPDATE Transactions SET status = 'REJECTED' WHERE camunda_process_id = ?`, [processId], async () => {
            io.emit('transfer-timeout', { amount: amount, message: rejectionReason });
            await safeComplete(taskService, task);
        });
    });
});

// --- GÖREV 4: Müşteriye Eşzamanlı SMS Gönderme ---
client.subscribe('send-sms', async ({ task, taskService }) => {
    const rawAmount = task.variables.get('amount') || task.variables.get('billAmount');
    const amount = parseFloat(rawAmount);
    const senderId = task.variables.get('senderId') || task.variables.get('payerAccount') || 'Müşteri';

    console.log(`\n✉️ [SMS SİSTEMİ TETİKLENDİ] ${senderId} hesabına mesaj iletiliyor: "Sayın müşterimiz, ${amount} TL tutarındaki işleminiz başarıyla gerçekleşmiştir."`);
    await safeComplete(taskService, task);
});

// --- GÖREV 5: Alt Süreç - Dolandırıcılık (Fraud) Kontrolü ---
client.subscribe('check-fraud', async ({ task, taskService }) => {
    const amount = parseFloat(task.variables.get('amount'));
    const recipientIban = task.variables.get('recipientIban');
    const blacklistedIbans = ["TR999999999999999999999999", "TR111111111111111111111111"];

    console.log(`\n🛡️ [GÜVENLİK KONTROLÜ] ${recipientIban} numaralı alıcı IBAN'ı taranıyor...`);

    if (blacklistedIbans.includes(recipientIban)) {
        console.log(`🚨 [FRAUD ALARMI] Şüpheli IBAN tespit edildi! İşlem anında bloke ediliyor.`);
        io.emit('transfer-timeout', { amount: amount, message: 'İşlem güvenlik politikası gereği reddedildi.' });
        await safeBpmnError(taskService, task, 'FRAUD_ERROR', 'Kara listeye alınmış IBAN.');
    } else {
        console.log(`✅ [GÜVENLİK ONAYI] IBAN temiz. Süreç devam ediyor.`);
        await safeComplete(taskService, task);
    }
});

// --- GÖREV 6: Alt Süreç - Sadakat Puanı ---
client.subscribe('add-cashback-points', async ({ task, taskService }) => {
    const amount = parseFloat(task.variables.get('amount'));
    const senderId = task.variables.get('senderId');
    const processId = task.processInstanceId;
    const cashbackRate = parseFloat(task.variables.get('cashbackRate')) || 0;
    
    if (cashbackRate > 0) {
        const cashbackAmount = amount * cashbackRate;
        console.log(`\n🎁 [CASHBACK] ${senderId} kullanıcısına ${cashbackAmount} Puan yüklendi.`);
        
        db.serialize(async () => {
            db.run(`UPDATE Accounts SET total_loyalty_points = COALESCE(total_loyalty_points, 0) + ? WHERE customer_id = ?`, [cashbackAmount, senderId]);
            db.get(`SELECT iban FROM Accounts WHERE customer_id = ?`, [senderId], async (err, row) => {
                if (row) {
                    db.run(`INSERT INTO Transactions (sender_iban, receiver_iban, amount, fee_amount, loyalty_points, status, camunda_process_id) VALUES (?, 'SİSTEM - ÖDÜL', 0, 0, ?, 'COMPLETED', ?)`, 
                    [row.iban, cashbackAmount, processId]);
                }
                await safeComplete(taskService, task);
            });
        });
    } else {
        console.log(`\n🎁 [CASHBACK] ${senderId} STANDART müşteri olduğu için puan yüklenmedi.`);
        await safeComplete(taskService, task);
    }
});

// =======================================================================
// HESAPLARIM ARASI TRANSFER (INTERNAL TRANSFER PROCESS)
// =======================================================================
client.subscribe('internal-validate-balance', async ({ task, taskService }) => {
    const customerId = task.variables.get('customerId');
    const fromAccountNo = task.variables.get('fromAccountNumber');
    const toAccountNo = task.variables.get('toAccountNumber');
    const amount = parseFloat(task.variables.get('amount'));

    console.log(`\n🔍 [İÇ TRANSFER KONTROL] ${customerId} | ${fromAccountNo} -> ${toAccountNo} | Tutar: ${amount} ₺`);

    db.all(`SELECT * FROM Accounts WHERE customer_id = ? AND account_number IN (?, ?)`, [customerId, fromAccountNo, toAccountNo], async (err, accounts) => {
        if (err || !accounts || accounts.length < 2) return await safeFailure(taskService, task, "Hesap yetkilendirme hatası");

        const senderAcc = accounts.find(a => a.account_number === fromAccountNo);
        const receiverAcc = accounts.find(a => a.account_number === toAccountNo);

        if (senderAcc.balance >= amount) {
            const processVariables = new Variables();
            processVariables.set('senderIban', senderAcc.iban);
            processVariables.set('receiverIban', receiverAcc.iban);
            await safeComplete(taskService, task, processVariables);
        } else {
            await safeFailure(taskService, task, "Yetersiz bakiye");
        }
    });
});

client.subscribe('internal-execute-transfer', async ({ task, taskService }) => {
    const amount = parseFloat(task.variables.get('amount'));
    const fromAccountNo = task.variables.get('fromAccountNumber');
    const toAccountNo = task.variables.get('toAccountNumber');
    const senderIban = task.variables.get('senderIban');
    const receiverIban = task.variables.get('receiverIban');
    const paymentDescription = task.variables.get('paymentDescription'); 
    const transactionDate = task.variables.get('transactionDate'); 
    const processId = task.processInstanceId;

    db.serialize(() => {
        db.run(`UPDATE Accounts SET balance = balance - ? WHERE account_number = ?`, [amount, fromAccountNo]);
        db.run(`UPDATE Accounts SET balance = balance + ? WHERE account_number = ?`, [amount, toAccountNo]);
        
        db.run(`INSERT INTO Transactions (sender_iban, receiver_iban, amount, fee_amount, loyalty_points, status, camunda_process_id, payment_description, transaction_date) 
                VALUES (?, ?, ?, 0, 0, 'COMPLETED', ?, ?, ?)`, 
        [senderIban, receiverIban, amount, processId, paymentDescription, transactionDate], async (err) => {
            if (!err) {
                io.emit('transfer-approved', { amount: amount, message: 'İç transfer başarıyla gerçekleşti.' });
                await safeComplete(taskService, task);
            } else {
                await safeFailure(taskService, task, "Veritabanı kayıt hatası");
            }
        });
    });
});

client.subscribe('internal-send-sms', async ({ task, taskService }) => {
    const amount = parseFloat(task.variables.get('amount'));
    const customerId = task.variables.get('customerId');
    console.log(`\n✉️ [SMS SİSTEMİ TETİKLENDİ] ${customerId} telefonuna mesaj iletiliyor: "Sayın müşterimiz, hesaplarınız arası ${amount} TL tutarındaki transferiniz başarıyla gerçekleşmiştir."`);
    await safeComplete(taskService, task);
});

client.subscribe('create-account-db', async ({ task, taskService }) => {
    const senderId = task.variables.get('senderId');
    const receiverAccountType = task.variables.get('receiverAccountType');
    const receiverCurrency = task.variables.get('receiverCurrency');
    const amount = parseFloat(task.variables.get('amount'));
    const vadeSonuMevla = parseFloat(task.variables.get('vadeSonuMevla')) || 0;

    const daysToMaturity = task.variables.get('daysToMaturity') || 0;
    const outOfHours = task.variables.get('isOutOfHours') || false;

    const newAccountNumber = Math.floor(10000000 + Math.random() * 90000000).toString();
    const newIban = `TR00999999${newAccountNumber}`;

    const today = new Date();
    const openingDateStr = today.toISOString(); 
    
    const valDate = new Date(today);
    if (outOfHours) {
        valDate.setDate(valDate.getDate() + 1);
    }
    const valueDateStr = valDate.toISOString().split('T')[0];

    let maturityDateStr = null;
    if (receiverAccountType === 'VADELI') {
        const matDate = new Date(valDate);
        matDate.setDate(matDate.getDate() + daysToMaturity);
        maturityDateStr = matDate.toISOString().split('T')[0];
    }

    console.log(`\n🏦 [YENİ HESAP] ${senderId} için ${newAccountNumber} hesap açılıyor. Valör: ${valueDateStr} | Vade Bitiş: ${maturityDateStr || 'Yok'}`);

    db.serialize(() => {
        db.run(`INSERT INTO Accounts (customer_id, account_type, account_number, balance, currency, iban, account_opening_date, value_date, maturity_date, days_to_maturity, maturity_value) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
        [senderId, receiverAccountType, newAccountNumber, amount, receiverCurrency, newIban, openingDateStr, valueDateStr, maturityDateStr, daysToMaturity, vadeSonuMevla], async (err) => {
            if (!err) {
                io.emit('transfer-approved', { message: 'Yeni hesap açıldı ve bakiye aktarıldı.' });
                await safeComplete(taskService, task);
            } else {
                await safeFailure(taskService, task, "Veritabanı hesap açma hatası: " + err.message);
            }
        });
    });
});

// =======================================================================
// YENİ KURUMSAL MİMARİ: EOD MULTI-INSTANCE (DMN ENTEGRELİ)
// =======================================================================

client.subscribe('fetch-matured-accounts', async ({ task, taskService }) => {
    const now = new Date();
    const todayStr = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
    
    console.log(`\n⏳ [GÜN SONU BATCH] Vadesi dolan hesaplar taranıyor... Tarih: ${todayStr}`);

    db.all(`SELECT id, customer_id, account_number, balance, maturity_value, days_to_maturity, customer_type FROM Accounts WHERE account_type = 'VADELI' AND maturity_date = ?`, [todayStr], async (err, accounts) => {
        if (err) return await safeFailure(taskService, task, "Veritabanı okuma hatası");

        const processVariables = new Variables();
        if (accounts && accounts.length > 0) {
            const formattedAccounts = accounts.map(acc => ({
                ...acc,
                balance: parseFloat(acc.balance) || 0,
                maturity_value: parseFloat(acc.maturity_value) || 0,
                days_to_maturity: parseInt(acc.days_to_maturity) || 0,
                customer_type: acc.customer_type || "STANDART" 
            }));

            console.log(`✅ [BATCH BULUNDU] ${formattedAccounts.length} hesap Camunda Multi-Instance motoruna yollanıyor...`);
            
            processVariables.setTyped('maturedAccounts', {
                value: JSON.stringify(formattedAccounts),
                type: 'json',
                valueInfo: {}
            });
            processVariables.set('hasMaturedAccounts', true);
        } else {
            console.log(`ℹ️ [BATCH BOŞ] Bugün vadesi dolan hesap bulunamadı.`);
            processVariables.set('hasMaturedAccounts', false);
            processVariables.setTyped('maturedAccounts', {
                value: '[]',
                type: 'json',
                valueInfo: {}
            }); 
        }

        await safeComplete(taskService, task, processVariables);
    });
});

client.subscribe('update-single-account', async ({ task, taskService }) => {
    const accountJson = task.variables.get('account'); 
    const account = typeof accountJson === 'string' ? JSON.parse(accountJson) : accountJson;
    
    const depositRate = parseFloat(task.variables.get('depositRate')) || 0; 
    
    const today = new Date();
    const localToday = new Date(today.getTime() - (today.getTimezoneOffset() * 60000));
    const newStartDateStr = localToday.toISOString().split('T')[0];

    const currentBalance = parseFloat(account.balance) || 0;
    const netInterest = parseFloat(account.maturity_value) || 0;
    
    const newBalance = currentBalance + netInterest;
    const newMaturityValue = newBalance * depositRate;
    
    const daysToAdd = parseInt(account.days_to_maturity) || 0;
    const nextMaturityDate = new Date(today);
    nextMaturityDate.setDate(nextMaturityDate.getDate() + daysToAdd);
    const newMaturityDateStr = new Date(nextMaturityDate.getTime() - (nextMaturityDate.getTimezoneOffset() * 60000)).toISOString().split('T')[0]

    db.run(`UPDATE Accounts SET 
        balance = ?, 
        value_date = ?, 
        maturity_date = ?,
        maturity_value = ?
        WHERE id = ?`, [newBalance, newStartDateStr, newMaturityDateStr, newMaturityValue, account.id], async (err) => {
        
        if (!err) {
            console.log(`   -> [DMN ONAYLI TEMDİT] Hesap No: ${account.account_number} | Eski Bakiye: ${currentBalance.toFixed(2)} | Kazanç: ${netInterest.toFixed(2)} | Yeni Bakiye: ${newBalance.toFixed(2)} | DMN Faizi: %${(depositRate * 100).toFixed(1)} | Yeni Hedef Getiri: ${newMaturityValue.toFixed(2)}`);
            await safeComplete(taskService, task);
        } else {
            console.error("Güncelleme hatası:", err.message);
            await safeFailure(taskService, task, "Hesap güncelleme hatası");
        }
    });
});

// =======================================================================
// FATURA ÖDEME SÜRECİ (GÜN SONU MUTABAKATI İÇİN PENDING KAYIT)
// =======================================================================

client.subscribe('Save-BillPayment-Transaction', async ({ task, taskService }) => {
    const islemZamani = task.variables.get('islemZamani');
    const billAmount = parseFloat(task.variables.get('billAmount2Transaction')) || 0;
    const subscriberNumber = task.variables.get('subscriberNumber');
    const senderAccount = task.variables.get('senderAccount');
    const institutionName = task.variables.get('institutionName') || 'Bilinmeyen Kurum';

    const transactionId = 'TRX-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const billReferenceNo = task.variables.get('billReferenceNo') || ('REF-' + Math.floor(Math.random() * 1000000));

    console.log(`\n🧾 [FATURA ÖDEME - EOD BEKLİYOR] Kurum: ${institutionName} | Abone: ${subscriberNumber} | Tutar: ${billAmount} TL`);

    db.run(
        `INSERT INTO eod_bill_payments 
        (transaction_id, bank_account, institution_name, subscriber_number, bill_reference_no, bill_amount, status, transaction_date) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [transactionId, senderAccount, institutionName, subscriberNumber, billReferenceNo, billAmount, 'PENDING', islemZamani],
        async (err) => {
            if (!err) {
                console.log(`   -> ✅ [BAŞARILI] İşlem EOD tablosuna kaydedildi. Dekont/TRX No: ${transactionId}`);
                await safeComplete(taskService, task);
            } else {
                console.error(`   -> ❌ [HATA] EOD tablosuna yazılamadı:`, err.message);
                await safeFailure(taskService, task, "Veritabanı fatura kayıt hatası: " + err.message);
            }
        }
    );
});

client.subscribe('fatura-odeme-onayla', async ({ task, taskService }) => {
    console.log(`\n💸 [FATURA ONAYI] Fatura ödeme adımı onaylandı, bakiye düşümü ve gün sonu kaydına geçiliyor...`);
    await safeComplete(taskService, task);
});

client.subscribe('deduct-bill-from-balance', async ({ task, taskService }) => {
    const billAmount = parsePositiveAmount(task.variables.get('billAmount'));
    const payerAccount = task.variables.get('payerAccount'); 
    const institutionName = task.variables.get('institutionName') || 'Bilinmeyen Kurum';
    const processId = task.processInstanceId;

    if (billAmount === null) {
        return await safeFailure(taskService, task, "Geçersiz fatura tutarı");
    }

    db.get(`SELECT id, balance, iban FROM Accounts WHERE account_number = ?`, [payerAccount], (err, row) => {
        if (err || !row) {
            return safeFailure(taskService, task, "Hesap bulunamadı");
        }

        const currentBalance = parseFloat(row.balance);
        if (!Number.isFinite(currentBalance) || currentBalance < billAmount) {
            return safeFailure(taskService, task, "Yetersiz bakiye");
        }

        db.run(`UPDATE Accounts SET balance = balance - ? WHERE id = ? AND balance >= ?`,
            [billAmount, row.id, billAmount], function (updateErr) {
            if (updateErr || this.changes !== 1) {
                return safeFailure(taskService, task, updateErr ? "Bakiye güncellenemedi" : "Yetersiz bakiye");
            }

            const remainingBalance = currentBalance - billAmount;
            db.run(`INSERT INTO Transactions (sender_iban, receiver_iban, amount, fee_amount, loyalty_points, status, camunda_process_id, payment_type, payment_description) 
                    VALUES (?, ?, ?, 0, 0, 'COMPLETED', ?, 'Fatura Ödeme', ?)`, 
                    [row.iban, `${institutionName}-KURUM`, billAmount, processId, `${institutionName} Faturası`], 
            async (insertErr) => {
                if (!insertErr) {
                    console.log(`\n💳 [BAKİYE GÜNCELLEME] Hesap No: ${payerAccount} | Eski: ${currentBalance} -> Yeni: ${remainingBalance} TL`);
                    await safeComplete(taskService, task);
                } else {
                    await safeFailure(taskService, task, "Geçmişe kayıt hatası");
                }
            });
        });
    });
});

client.subscribe('banka-fatura-para-havuzuna-aktarim', async ({ task, taskService }) => {
    const billAmount = parsePositiveAmount(task.variables.get('billAmount'));
    const payerAccount = task.variables.get('payerAccount');
    const processId = task.processInstanceId;

    if (!payerAccount || billAmount === null) {
        return await safeFailure(taskService, task, 'Havuz aktarım bilgileri eksik');
    }

    db.get(
        `SELECT id FROM bill_pool_ledger
         WHERE process_id = ? AND direction = 'IN'`,
        [processId],
        async (ledgerErr, existingLedger) => {
            if (ledgerErr) return await safeFailure(taskService, task, 'Havuz kayıt kontrolü başarısız');
            if (existingLedger) {
                console.log(`   -> ℹ️ [HAVUZ] İşlem zaten havuza aktarıldı. Proses: ${processId}`);
                return await safeComplete(taskService, task);
            }

            db.run(
                `UPDATE Accounts SET balance = balance + ? WHERE account_number = 'FATURA-HAVUZ-001'`,
                [billAmount],
                async function (poolErr) {
                    if (poolErr) return await safeFailure(taskService, task, 'Fatura havuzuna aktarım başarısız');
                    if (this.changes !== 1) return await safeFailure(taskService, task, 'Fatura havuz hesabı bulunamadı');

                    db.run(
                        `INSERT INTO bill_pool_ledger
                         (process_id, source_account, amount, direction)
                         VALUES (?, ?, ?, 'IN')`,
                        [processId, payerAccount, billAmount],
                        async (ledgerInsertErr) => {
                            if (ledgerInsertErr) return await safeFailure(taskService, task, 'Havuz ledger kaydı başarısız');

                            console.log(`   -> 🏦 [HAVUZ AKTARIM] ${payerAccount} hesabından düşen tutar Fatura Havuzu'na ${billAmount.toFixed(2)} TL aktarıldı.`);
                            await safeComplete(taskService, task);
                        }
                    );
                }
            );
        }
    );
});

client.subscribe('gun-sonu-talimatlari-hazirla', async ({ task, taskService }) => {
    const today = new Date();
    const localToday = new Date(today.getTime() - (today.getTimezoneOffset() * 60000));
    const todayStr = localToday.toISOString().split('T')[0];

    db.all(
        `SELECT * FROM payment_instructions
         WHERE (next_payment_date IS NULL OR next_payment_date <= ?)`,
        [todayStr],
        async (err, instructions) => {
            if (err) return await safeFailure(taskService, task, 'Talimatlar okunamadı');

            const processVariables = new Variables();
            processVariables.setTyped('paymentInstructions', {
                value: JSON.stringify(instructions || []),
                type: 'json',
                valueInfo: {}
            });
            await safeComplete(taskService, task, processVariables);
        }
    );
});

client.subscribe('fatura-sorgula', async ({ task, taskService }) => {
    let instruction = null;
    const paymentInstructionJson = task.variables.get('paymentInstruction');
    if (paymentInstructionJson) {
        try {
            instruction = typeof paymentInstructionJson === 'string'
                ? JSON.parse(paymentInstructionJson)
                : paymentInstructionJson;
        } catch (error) {
            return await safeFailure(taskService, task, 'Talimat verisi okunamadı');
        }
    }

    const aboneNo = instruction
        ? instruction.subscriber_number
        : (task.variables.get('aboneNo') || '12345678');
    const isActive = instruction ? Number(instruction.is_active) : null;
    const institutionName = instruction
        ? (BILL_INSTITUTIONS[instruction.institution_name]?.name || instruction.institution_name)
        : (task.variables.get('institutionName') || 'Bilinmeyen Kurum');
    const institution = Object.values(BILL_INSTITUTIONS).find((item) => item.name === institutionName)
        || Object.values(BILL_INSTITUTIONS).find((item) => item.mockName === String(institutionName).toLowerCase())
        || BILL_INSTITUTIONS['Su'];

    console.log(`\n🔎 [FATURA SORGUSU] ${aboneNo} numaralı ${institution.name} abonesi aranıyor...`);

    try {
        const response = await axios.get(`http://localhost:3000/mock-api/bill-institutions/${institution.mockName}/inquiry/${aboneNo}`);
        const faturaBilgisi = response.data;

        console.log(`   -> 📄 Fatura Bulundu! Tutar: ${faturaBilgisi.tutar} TL | Durum: ${faturaBilgisi.durum} | Ref: ${faturaBilgisi.faturaReferansNo}`);

        const processVariables = new Variables();
        processVariables.set('billAmount', faturaBilgisi.tutar);
        processVariables.set('faturaDurumu', faturaBilgisi.durum);
        processVariables.set('dueDate', faturaBilgisi.sonOdemeTarihi);
        processVariables.set('billReferenceNo', faturaBilgisi.faturaReferansNo);
        processVariables.set('subscriberNumberAPI', faturaBilgisi.aboneNo);
        processVariables.set('institutionName', institution.name);
        if (instruction) {
            const accountQuery = await new Promise((resolve) => {
                db.get(
                    `SELECT balance, customer_type FROM Accounts WHERE account_number = ?`,
                    [instruction.account_number],
                    (accountErr, account) => resolve(accountErr ? null : account)
                );
            });
            processVariables.set('Balance', Number(accountQuery?.balance) || 0);
            processVariables.set('customerType', accountQuery?.customer_type || 'STANDART');
            processVariables.set('isActive', isActive);
            processVariables.set('accountNumber', instruction.account_number);
            processVariables.set('payerAccount', instruction.account_number);
            processVariables.set('customerId', instruction.customer_id);
            processVariables.set('paymentInstructionId', instruction.id);
            processVariables.set('odemeBorcuVar',
                faturaBilgisi.durum === 'Ödenmedi' &&
                Number(faturaBilgisi.tutar) > 0 &&
                (instruction.max_amount === null ||
                    Number(faturaBilgisi.tutar) <= Number(instruction.max_amount))
            );
        } else {
            processVariables.set('odemeBorcuVar',
                faturaBilgisi.durum === 'Ödenmedi' && Number(faturaBilgisi.tutar) > 0
            );
        }

        await safeComplete(taskService, task, processVariables);
    } catch (error) {
        console.error(`   -> ❌ İSKİ API Bağlantı Hatası:`, error.message);
        await safeFailure(taskService, task, "Kurum servisine ulaşılamadı.");
    }
});

client.subscribe('talimati-eod-tablosuna-ekle', async ({ task, taskService }) => {
    const instructionId = task.variables.get('paymentInstructionId');
    const accountNumber = task.variables.get('accountNumber');
    const customerId = task.variables.get('customerId');
    const subscriberNumber = task.variables.get('subscriberNumberAPI');
    const institutionName = task.variables.get('institutionName') || 'Bilinmeyen Kurum';
    const billAmount = Number(task.variables.get('billAmount'));
    const billReferenceNo = task.variables.get('billReferenceNo');
    const odemeBorcuVar = task.variables.get('odemeBorcuVar') === true;
    const isActive = Number(task.variables.get('isActive')) === 1;

    if (!instructionId || !accountNumber || !subscriberNumber || !billReferenceNo) {
        return await safeFailure(taskService, task, 'Talimat veya fatura verileri eksik');
    }
    if (!odemeBorcuVar || !isActive) {
        return await safeComplete(taskService, task);
    }
    if (!Number.isFinite(billAmount) || billAmount <= 0) {
        return await safeFailure(taskService, task, 'Geçersiz fatura tutarı');
    }

    db.get(
        `SELECT id FROM eod_bill_payments
         WHERE bill_reference_no = ? AND subscriber_number = ?`,
        [billReferenceNo, subscriberNumber],
        async (lookupErr, existing) => {
            if (lookupErr) return await safeFailure(taskService, task, 'EOD kayıt kontrolü başarısız');
            if (existing) {
                return await safeComplete(taskService, task);
            }

            const transactionId = 'TRX-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
            const transactionDate = new Date().toISOString();

            db.run(
                `INSERT INTO eod_bill_payments (
                    transaction_id, bank_account, institution_name, subscriber_number,
                    bill_reference_no, bill_amount, status, transaction_date
                 ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
                [transactionId, accountNumber, institutionName, subscriberNumber, billReferenceNo, billAmount, transactionDate],
                async (insertErr) => {
                    if (insertErr) return await safeFailure(taskService, task, 'EOD kaydı oluşturulamadı');

                    db.get(
                        `SELECT payment_day FROM payment_instructions WHERE id = ?`,
                        [instructionId],
                        async (instructionErr, instruction) => {
                            let nextPaymentDate = null;
                            if (!instructionErr && instruction && instruction.payment_day) {
                                const now = new Date();
                                const candidate = new Date(now.getFullYear(), now.getMonth() + 1, instruction.payment_day);
                                nextPaymentDate = new Date(candidate.getTime() - (candidate.getTimezoneOffset() * 60000))
                                    .toISOString().split('T')[0];
                            }

                            db.run(
                                `UPDATE payment_instructions
                                 SET last_payment_status = 'PENDING',
                                     last_payment_date = ?,
                                     next_payment_date = ?,
                                     updated_at = CURRENT_TIMESTAMP
                                 WHERE id = ?`,
                                [transactionDate, nextPaymentDate, instructionId],
                                async (updateErr) => {
                                    if (updateErr) return await safeFailure(taskService, task, 'Talimat durum güncellenemedi');

                                    io.emit('payment-instruction-added-to-eod', {
                                        instructionId,
                                        customerId,
                                        transactionId,
                                        billReferenceNo,
                                        billAmount
                                    });
                                    await safeComplete(taskService, task);
                                }
                            );
                        }
                    );
                }
            );
        }
    );
});

client.subscribe('talimat-kapali-mesaji', async ({ task, taskService }) => {
    const instructionId = task.variables.get('paymentInstructionId');
    const customerId = task.variables.get('customerId');
    const subscriberNumber = task.variables.get('subscriberNumberAPI');

    console.log(`\n⚠️ [TALİMAT PASİF] Talimat: ${instructionId} | Müşteri: ${customerId} | Abone: ${subscriberNumber}`);
    io.emit('payment-instruction-inactive', {
        instructionId,
        customerId,
        subscriberNumber,
        message: 'Talimat pasif olduğu için ödeme yapılmadı.'
    });
    await safeComplete(taskService, task);
});

// =======================================================================
// YENİ: GÜN SONU EOD MUTABAKAT SÜRECİ WORKER'LARI
// =======================================================================

const updateEodStatuses = async (results, status) => {
    const validResults = (Array.isArray(results) ? results : []).filter((result) =>
        result && typeof result.transaction_id === 'string'
    );

    for (const result of validResults) {
        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE eod_bill_payments SET status = ? WHERE transaction_id = ? AND status = 'PENDING'`,
                [status, result.transaction_id],
                function (updateErr) {
                    if (updateErr) return reject(updateErr);
                    resolve(this.changes === 1);
                }
            );
        });
    }
};

const refundEodTransactions = async (transactions) => {
    const pendingTransactions = (Array.isArray(transactions) ? transactions : []).filter((transaction) =>
        transaction && typeof transaction.transaction_id === 'string'
    );

    for (const transaction of pendingTransactions) {
        const wasPending = await new Promise((resolve, reject) => {
            db.run(
                `UPDATE eod_bill_payments SET status = 'REJECTED'
                 WHERE transaction_id = ? AND status = 'PENDING'`,
                [transaction.transaction_id],
                function (updateErr) {
                    if (updateErr) return reject(updateErr);
                    resolve(this.changes === 1);
                }
            );
        });

        const refundAmount = Number(transaction.bill_amount);
        if (wasPending && (!Number.isFinite(refundAmount) || refundAmount <= 0)) {
            throw new Error("Geçersiz iade tutarı");
        }

        if (wasPending) {
            await new Promise((resolve, reject) => {
                db.run(
                    `UPDATE Accounts SET balance = balance + ? WHERE account_number = ?`,
                    [refundAmount, transaction.bank_account],
                    function (updateErr) {
                        if (updateErr) return reject(updateErr);
                        if (this.changes !== 1) return reject(new Error("İade hesabı bulunamadı"));
                        resolve();
                    }
                );
            });

            await new Promise((resolve, reject) => {
                db.run(
                    `UPDATE Accounts SET balance = balance - ? 
                     WHERE account_number = 'FATURA-HAVUZ-001' AND balance >= ?`,
                    [refundAmount, refundAmount],
                    function (poolErr) {
                        if (poolErr) return reject(poolErr);
                        if (this.changes !== 1) return reject(new Error("Fatura havuzunda yeterli bakiye yok"));
                        resolve();
                    }
                );
            });
        }
    }
};

// 1. PENDING İşlemleri Topla ve CSV'ye Çevir
client.subscribe('gun-sonu-islemlerini-hazirla', async ({ task, taskService }) => {
    console.log(`\n📂 [GÜN SONU] Tüm kurumlar için PENDING işlemler toplanıyor...`);

    db.all(`SELECT * FROM eod_bill_payments WHERE status = 'PENDING'`, async (err, rows) => {
        if (err) return await safeFailure(taskService, task, "Veritabanı okuma hatası");

        if (rows && rows.length > 0) {
            const csvFilePath = './iski_eod_settlement.csv';
            const csvWriter = createObjectCsvWriter({
                path: csvFilePath,
                header: [
                    { id: 'transaction_id', title: 'TRANSACTION_ID' },
                    { id: 'bank_account', title: 'BANK_ACCOUNT' },
                    { id: 'subscriber_number', title: 'SUBSCRIBER_NUMBER' },
                    { id: 'bill_reference_no', title: 'BILL_REFERENCE_NO' },
                    { id: 'bill_amount', title: 'BILL_AMOUNT' },
                    { id: 'transaction_date', title: 'TRANSACTION_DATE' }
                ]
            });

            try {
                // CSV dosyasını oluşturur
                await csvWriter.writeRecords(rows);
                console.log(`✅ [CSV OLUŞTURULDU] ${rows.length} işlem ${csvFilePath} dosyasına yazıldı.`);
                
                const processVariables = new Variables();
                processVariables.setTyped('pendingTransactions', {
                    value: JSON.stringify(rows),
                    type: 'json',
                    valueInfo: {}
                });
                await safeComplete(taskService, task, processVariables);
            } catch (csvErr) {
                console.error(`❌ [CSV HATASI]`, csvErr.message);
                await safeFailure(taskService, task, "CSV oluşturma hatası");
            }
        } else {
            console.log(`ℹ️ [EOD BOŞ] İSKİ için bekleyen PENDING işlem bulunamadı.`);
            const processVariables = new Variables();
            processVariables.setTyped('pendingTransactions', {
                value: '[]',
                type: 'json',
                valueInfo: {}
            });
            await safeComplete(taskService, task, processVariables);
        }
    });
});

const sendEodSettlementRequest = async (task, taskService) => {
    const transactionsJson = task.variables.get('pendingTransactions');
    let transactions;
    try {
        transactions = typeof transactionsJson === 'string' ? JSON.parse(transactionsJson) : transactionsJson;
    } catch (error) {
        return await safeFailure(taskService, task, "Bekleyen işlem verisi okunamadı");
    }
    if (!Array.isArray(transactions)) {
        return await safeFailure(taskService, task, "Bekleyen işlem verisi geçersiz");
    }

    if (transactions.length === 0) {
        console.log(`ℹ️ [EOD] Bekleyen işlem yok; İSKİ API çağrısı atlanıyor.`);
        const processVariables = new Variables();
        processVariables.set('apiCevapVerdiMi', true);
        processVariables.setTyped('iskiResponse', {
            value: JSON.stringify({ totalProcessed: 0, results: [] }),
            type: 'json',
            valueInfo: {}
        });
        return await safeComplete(taskService, task, processVariables);
    }

    const groupedByInstitution = {};
    for (const transaction of transactions) {
        const institution = Object.values(BILL_INSTITUTIONS).find((item) => item.name === transaction.institution_name)
            || BILL_INSTITUTIONS['Su'];
        if (!groupedByInstitution[institution.mockName]) {
            groupedByInstitution[institution.mockName] = [];
        }
        groupedByInstitution[institution.mockName].push(transaction);
    }

    console.log(`\n🚀 [KURUMLAR API] ${transactions.length} işlem kuruma göre mutabakat için gönderiliyor...`);

    try {
        const settlementResults = [];
        let totalProcessed = 0;
        for (const [mockName, institutionTransactions] of Object.entries(groupedByInstitution)) {
            const response = await axios.post(
                `http://localhost:3000/mock-api/bill-institutions/${mockName}/eod-settlement`,
                { transactions: institutionTransactions },
                { timeout: 15000 }
            );
            totalProcessed += response.data.totalProcessed || institutionTransactions.length;
            settlementResults.push(...(response.data.results || []));
        }

        console.log(`✅ [KURUMLAR API] Mutabakat cevapları başarıyla alındı.`);
        
        const processVariables = new Variables();
        processVariables.set('apiCevapVerdiMi', true);
        processVariables.setTyped('iskiResponse', {
            value: JSON.stringify({
                settlementDate: new Date().toISOString(),
                totalProcessed,
                results: settlementResults
            }),
            type: 'json',
            valueInfo: {}
        });
        
        await safeComplete(taskService, task, processVariables);

    } catch (error) {
        console.error(`❌ [API ZAMAN AŞIMI VEYA HATA] Kurum mutabakat API'leri cevap vermedi.`);
        
        let retryCount = Number(task.variables.get('retryCount')) || 0;
        retryCount++;
        console.log(`⏱️ Deneme sayısı: ${retryCount}/3`);

        const processVariables = new Variables();
        processVariables.set('apiCevapVerdiMi', false);
        processVariables.set('retryCount', retryCount);
        
        await safeComplete(taskService, task, processVariables);
    }
};

// 2. İSKİ API'sine Gönder ve Teyit Bekle
client.subscribe('kurum-API-Teyite-Gonder', async ({ task, taskService }) => {
    await sendEodSettlementRequest(task, taskService);
});

// 3. Cevabı Değerlendir
client.subscribe('islem-durumlarını-degerlendir', async ({ task, taskService }) => {
    const iskiResponseJson = task.variables.get('iskiResponse');
    
    if (!iskiResponseJson) return await safeFailure(taskService, task, "İSKİ'den gelen geçerli bir cevap bulunamadı.");

    let iskiResponse;
    try {
        iskiResponse = typeof iskiResponseJson === 'string' ? JSON.parse(iskiResponseJson) : iskiResponseJson;
    } catch (error) {
        return await safeFailure(taskService, task, "İSKİ cevabı okunamadı");
    }
    if (!iskiResponse || !Array.isArray(iskiResponse.results)) {
        return await safeFailure(taskService, task, "İSKİ cevabı geçersiz");
    }
    console.log(`\n⚖️ [DEĞERLENDİRME] İSKİ'den gelen sonuçlar işleniyor... Toplam: ${iskiResponse.totalProcessed}`);

    const transactionsJson = task.variables.get('pendingTransactions');
    let transactions;
    try {
        transactions = typeof transactionsJson === 'string' ? JSON.parse(transactionsJson) : transactionsJson;
    } catch (error) {
        return await safeFailure(taskService, task, "Bekleyen işlem verisi okunamadı");
    }
    if (!Array.isArray(transactions)) {
        return await safeFailure(taskService, task, "Bekleyen işlem verisi geçersiz");
    }

    const rejectedIds = new Set(
        iskiResponse.results
            .filter(r => r.status === 'REJECTED' && typeof r.transaction_id === 'string')
            .map(r => r.transaction_id)
    );
    const rejectedTransactions = transactions.filter(transaction => rejectedIds.has(transaction.transaction_id));
    try {
        await refundEodTransactions(rejectedTransactions);
    } catch (error) {
        return await safeFailure(taskService, task, "Reddedilen işlemler iade edilemedi");
    }

    const hasAnyApproved = iskiResponse.results.some(r => r.status === 'APPROVED');
    const odemeUygunMu = hasAnyApproved;

    console.log(`   -> Sonuç: Ödemeler uygun mu? ${odemeUygunMu ? 'EVET (Kısmen)' : 'HAYIR (Hepsi Reddedildi)'}`);

    const processVariables = new Variables();
    processVariables.set('odemeUygunMu', odemeUygunMu);
    await safeComplete(taskService, task, processVariables);
});

// --- İPTAL/İADE SENARYOSU (odemeUygunMu == false) ---
client.subscribe('abonenin-hesabina-fatura-tutarini-iade-et', async ({ task, taskService }) => {
    console.log(`\n💸 [İADE] İşlemler reddedildiği için abonelere ücretleri iade ediliyor...`);
    const transactionsJson = task.variables.get('pendingTransactions');
    const responseJson = task.variables.get('iskiResponse');

    try {
        const transactions = typeof transactionsJson === 'string' ? JSON.parse(transactionsJson) : transactionsJson;
        const response = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;
        const rejectedIds = new Set(
            (response && Array.isArray(response.results) ? response.results : [])
                .filter(r => r.status === 'REJECTED')
                .map(r => r.transaction_id)
        );
        await refundEodTransactions((transactions || []).filter(transaction => rejectedIds.has(transaction.transaction_id)));
        await safeComplete(taskService, task);
    } catch (error) {
        await safeFailure(taskService, task, "Fatura iade verileri okunamadı");
    }
});

client.subscribe('aboneye-bakiye-iade-mesaji-gonder', async ({ task, taskService }) => {
    console.log(`\n✉️ [SMS] Abonelere iade bilgilendirme mesajları gönderiliyor...`);
    await safeComplete(taskService, task);
});

client.subscribe('veritabanini-guncelle-iptal', async ({ task, taskService }) => {
     console.log(`\n🗄️ [DB GÜNCELLEME] eod_bill_payments tablosundaki ilgili kayıtlar 'REJECTED' yapılıyor...`);
     const transactionsJson = task.variables.get('pendingTransactions');
     try {
         const transactions = typeof transactionsJson === 'string' ? JSON.parse(transactionsJson) : transactionsJson;
         await refundEodTransactions(transactions);
         await safeComplete(taskService, task);
     } catch (error) {
         await safeFailure(taskService, task, "İptal edilen işlemler güncellenemedi");
     }
});

// --- BAŞARILI SENARYO (odemeUygunMu == true) ---
client.subscribe('kurum-API-faturasi-odenen-aboneleri-bildir', async ({ task, taskService }) => {
    console.log(`\n📣 [BİLDİRİM] Başarılı ödemeler kuruma kesin olarak bildiriliyor...`);
    await safeComplete(taskService, task);
});

client.subscribe('kuruma-odeme-yap', async ({ task, taskService }) => {
    const responseJson = task.variables.get('iskiResponse');
    const pendingJson = task.variables.get('pendingTransactions');

    let response = null;
    let pendingTransactions = [];
    try {
        response = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;
        pendingTransactions = typeof pendingJson === 'string' ? JSON.parse(pendingJson) : (pendingJson || []);
    } catch (error) {
        return await safeFailure(taskService, task, 'EOD ödeme verisi okunamadı');
    }

    const approvedIds = new Set(
        (response && Array.isArray(response.results) ? response.results : [])
            .filter((result) => result.status === 'APPROVED')
            .map((result) => result.transaction_id)
    );
    const approvedTransactions = (Array.isArray(pendingTransactions) ? pendingTransactions : [])
        .filter((transaction) => approvedIds.has(transaction.transaction_id));
    const transferAmount = approvedTransactions.reduce(
        (sum, transaction) => sum + (Number(transaction.bill_amount) || 0),
        0
    );

    if (transferAmount <= 0) {
        console.log(`\nℹ️ [EFT/HAVALE] Kuruma aktarılacak onaylı tutar bulunamadı.`);
        return await safeComplete(taskService, task);
    }

    db.run(
        `UPDATE Accounts SET balance = balance - ?
         WHERE account_number = 'FATURA-HAVUZ-001' AND balance >= ?`,
        [transferAmount, transferAmount],
        async function (poolErr) {
            if (poolErr) return await safeFailure(taskService, task, 'Havuz bakiyesi düşürülemedi');
            if (this.changes !== 1) return await safeFailure(taskService, task, 'Fatura havuzunda yeterli bakiye yok');

            db.run(
                `INSERT INTO bill_pool_ledger
                 (process_id, source_account, amount, direction, transaction_id)
                 VALUES (?, 'FATURA-HAVUZ-001', ?, 'OUT', ?)`,
                [task.processInstanceId, transferAmount, approvedTransactions.map((t) => t.transaction_id).join(',')],
                async (ledgerErr) => {
                    if (ledgerErr) return await safeFailure(taskService, task, 'Kuruma ödeme havuz kaydı oluşturulamadı');

                    const institutionNames = [...new Set(approvedTransactions
                        .map((transaction) => transaction.institution_name)
                        .filter(Boolean))];
                    console.log(`\n💰 [EFT/HAVALE] ${institutionNames.join(', ') || 'Kuruma'} havuzdan ${transferAmount.toFixed(2)} TL aktarılıyor...`);
                    await safeComplete(taskService, task);
                }
            );
        }
    );
});

client.subscribe('veritabanini-guncelle-odendi', async ({ task, taskService }) => {
     console.log(`\n🗄️ [DB GÜNCELLEME] eod_bill_payments tablosundaki kayıtlar 'SETTLED' (ÖDENDİ) yapılıyor...`);
     const responseJson = task.variables.get('iskiResponse');
     try {
         const response = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;
         await updateEodStatuses((response && response.results || []).filter(r => r.status === 'APPROVED'), 'SETTLED');
         await safeComplete(taskService, task);
     } catch (error) {
         await safeFailure(taskService, task, "Onaylanan işlemler güncellenemedi");
     }
});