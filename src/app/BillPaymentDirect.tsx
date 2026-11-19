import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Category = 'Su' | 'Elektrik' | 'Doğalgaz' | 'İnternet';
type FundingSource = 'wallet' | 'card';

const CATEGORY_OPTIONS: {
  label: Category;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
}[] = [
  { label: 'Su', icon: 'water' },
  { label: 'Elektrik', icon: 'flash' },
  { label: 'Doğalgaz', icon: 'fire' },
  { label: 'İnternet', icon: 'wifi' },
];

export default function BillPaymentDirect() {
  const router = useRouter();
  const { accounts, fetchWalletData } = useStore();
  const [category, setCategory] = useState<Category>('Elektrik');
  const [subscriberNumber, setSubscriberNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [fundingSource, setFundingSource] = useState<FundingSource>('wallet');
  const [isSuccessVisible, setSuccessVisible] = useState(false);
  const [billStatus, setBillStatus] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [isInquiryLoading, setIsInquiryLoading] = useState(false);

  const canPay =
    subscriberNumber.trim().length > 0 &&
    amount.trim().length > 0 &&
    billStatus === 'Ödenmedi';

  useEffect(() => {
    fetchWalletData();
  }, [fetchWalletData]);

  const handleBillInquiry = async () => {
    if (!subscriberNumber.trim()) {
      alert('Abone / tesisat numarası gerekli.');
      return;
    }

    const institutionMockNames: Record<Category, string> = {
      Su: 'iski',
      Elektrik: 'tedas',
      Doğalgaz: 'igdas',
      İnternet: 'turktelekom',
    };

    setIsInquiryLoading(true);
    setAmount('');
    setBillStatus('');
    setDueDate('');

    try {
      const mockName = institutionMockNames[category];
      const response = await fetch(
        `http://192.168.1.106:3000/mock-api/bill-institutions/${mockName}/inquiry/${subscriberNumber.trim()}`,
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Fatura sorgulanamadı');

      setAmount(String(Number(data.tutar) || 0));
      setBillStatus(data.durum || '');
      setDueDate(data.sonOdemeTarihi || '');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Fatura sorgulanamadı.');
    } finally {
      setIsInquiryLoading(false);
    }
  };

  const handlePayment = async () => {
        if (!canPay) return;

        const paymentAccount =
          accounts.find((account) => account.account_type === 'VADESIZ') || accounts[0];
        if (!paymentAccount) {
          alert('Ödeme yapılacak hesap bulunamadı.');
          return;
        }
        
        try {
          const response = await fetch('http://192.168.1.106:3000/api/pay-bill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              customerId: 'Ahmet_123',
              accountNumber: paymentAccount.account_number,
              subscriberNumber: subscriberNumber,
              category: category
            })
          });

          const data = await response.json();
          if (data.success) {
            setSuccessVisible(true);
          } else {
            alert('Ödeme başlatılamadı: ' + data.error);
          }
        } catch (error) {
          alert('Sunucuya bağlanılamadı.');
        }
      };

  return (
    <LinearGradient colors={['#040268', '#1410B4', '#040268']} style={styles.root}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Geri dön"
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/dashboard'))}
            style={styles.backButton}
          >
            <MaterialCommunityIcons name="chevron-left" size={28} color="#FFFFFF" />
          </Pressable>
          <View>
            <Text style={styles.eyebrow}>FATURA ÖDEME MERKEZİ</Text>
            <Text style={styles.title}>Fatura Ödeme</Text>
          </View>
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.introCard}>
            <View style={styles.introIcon}>
              <MaterialCommunityIcons name="receipt-text-check-outline" size={24} color="#FFFFFF" />
            </View>
            <View style={styles.introCopy}>
              <Text style={styles.introTitle}>Faturanı şimdi öde</Text>
              <Text style={styles.introText}>Talimat oluşturmadan tek seferlik ödeme yap.</Text>
            </View>
          </View>

          <Text style={styles.sectionTitle}>Fatura türü</Text>
          <ScrollView
            contentContainerStyle={styles.categoryRow}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {CATEGORY_OPTIONS.map((option) => {
              const isSelected = category === option.label;
              return (
                <Pressable
                  accessibilityRole="button"
                  key={option.label}
                  onPress={() => {
                    setCategory(option.label);
                    setAmount('');
                    setBillStatus('');
                    setDueDate('');
                  }}
                  style={[styles.categoryOption, isSelected && styles.categoryOptionSelected]}
                >
                  <MaterialCommunityIcons
                    color={isSelected ? '#FFFFFF' : '#A8A8BA'}
                    name={option.icon}
                    size={21}
                  />
                  <Text style={[styles.categoryText, isSelected && styles.categoryTextSelected]}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <Text style={styles.sectionTitle}>Fatura bilgileri</Text>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Abone / Tesisat No</Text>
            <TextInput
              keyboardType="number-pad"
              onChangeText={(value) => {
                setSubscriberNumber(value);
                setAmount('');
                setBillStatus('');
                setDueDate('');
              }}
              placeholder="Numarayı girin"
              placeholderTextColor="#77788A"
              style={styles.input}
              value={subscriberNumber}
            />
          </View>

          <Pressable
            accessibilityRole="button"
            disabled={!subscriberNumber.trim() || isInquiryLoading}
            onPress={handleBillInquiry}
            style={({ pressed }) => [
              styles.inquiryButton,
              (!subscriberNumber.trim() || isInquiryLoading) && styles.inquiryButtonDisabled,
              pressed && styles.pressed,
            ]}
          >
            <MaterialCommunityIcons name="magnify" size={20} color="#FFFFFF" />
            <Text style={styles.inquiryButtonText}>
              {isInquiryLoading ? 'Fatura sorgulanıyor...' : 'Faturayı Sorgula'}
            </Text>
          </Pressable>

          {amount && (
            <View style={styles.billResultCard}>
              <View style={styles.billResultHeader}>
                <Text style={styles.billResultLabel}>Sorgu sonucu</Text>
                <View
                  style={[
                    styles.billStatusBadge,
                    billStatus === 'Ödenmedi' ? styles.billStatusPending : styles.billStatusPaid,
                  ]}
                >
                  <Text style={styles.billStatusText}>{billStatus}</Text>
                </View>
              </View>
              <Text style={styles.billAmountText}>{Number(amount).toLocaleString('tr-TR', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })} ₺</Text>
              {dueDate ? <Text style={styles.billDueText}>Son ödeme tarihi: {dueDate}</Text> : null}
            </View>
          )}

          <Text style={styles.sectionTitle}>Ödeme kaynağı</Text>
          <View style={styles.fundingRow}>
            <FundingOption
              icon="wallet-outline"
              label="Cüzdan Bakiyemden Öde"
              selected={fundingSource === 'wallet'}
              onPress={() => setFundingSource('wallet')}
            />
            <FundingOption
              icon="credit-card-outline"
              label="Kayıtlı Karttan Çek"
              selected={fundingSource === 'card'}
              onPress={() => setFundingSource('card')}
            />
          </View>

          <View style={styles.infoRow}>
            <MaterialCommunityIcons name="information-outline" size={18} color="#A8A8BA" />
            <Text style={styles.infoText}>Ödeme tamamlandığında işlem dekontunu görebilirsin.</Text>
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            disabled={!canPay}
            onPress={handlePayment}
            style={({ pressed }) => [
              styles.payButton,
              !canPay && styles.payButtonDisabled,
              pressed && canPay && styles.pressed,
            ]}
          >
            <LinearGradient colors={['#ED21D9', '#970DD9']} style={styles.payButtonGradient}>
              <Text style={styles.payButtonText}>Ödemeyi Başlat</Text>
              <MaterialCommunityIcons name="arrow-right" size={20} color="#FFFFFF" />
            </LinearGradient>
          </Pressable>
        </View>
      </SafeAreaView>

      <Modal animationType="fade" transparent visible={isSuccessVisible}>
        <View style={styles.successOverlay}>
          <View style={styles.successCard}>
            <View style={styles.successIcon}>
              <MaterialCommunityIcons name="check" size={30} color="#FFFFFF" />
            </View>
            <Text style={styles.successTitle}>Ödeme Başarılı</Text>
            <Text style={styles.successText}>
              {category} faturanız için {amount || '0'} ₺ tutarındaki ödeme alındı.
            </Text>
            <Pressable
              onPress={() => {
                setSuccessVisible(false);
                router.replace('/dashboard');
              }}
              style={styles.successButton}
            >
              <Text style={styles.successButtonText}>Dashboard&apos;a Dön</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </LinearGradient>
  );
}

function FundingOption({
  icon,
  label,
  selected,
  onPress,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.fundingOption, selected && styles.fundingOptionSelected]}
    >
      <MaterialCommunityIcons color={selected ? '#ED21D9' : '#A8A8BA'} name={icon} size={21} />
      <Text style={styles.fundingLabel}>{label}</Text>
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected && <View style={styles.radioDot} />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safeArea: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 20 },
  backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { color: '#FFFFFF', fontSize: 9, fontWeight: '700', letterSpacing: 1.2 },
  title: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', marginTop: 5 },
  content: { paddingHorizontal: 20, paddingBottom: 115 },
  introCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#020024', borderColor: '#2A2770', borderRadius: 18, borderWidth: 1, padding: 16 },
  introIcon: { alignItems: 'center', backgroundColor: '#1410B4', borderRadius: 14, height: 46, justifyContent: 'center', width: 46 },
  introCopy: { flex: 1, marginLeft: 12 },
  introTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  introText: { color: '#A8A8BA', fontSize: 12, marginTop: 5 },
  sectionTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', marginBottom: 12, marginTop: 25 },
  categoryRow: { gap: 8 },
  categoryOption: { alignItems: 'center', backgroundColor: 'transparent', borderColor: '#2A2770', borderRadius: 12, borderWidth: 1, gap: 6, minWidth: 78, paddingHorizontal: 13, paddingVertical: 11 },
  categoryOptionSelected: { backgroundColor: '#1410B4', borderColor: '#ED21D9' },
  categoryText: { color: '#A8A8BA', fontSize: 12, fontWeight: '700' },
  categoryTextSelected: { color: '#FFFFFF' },
  fieldGroup: { marginBottom: 14 },
  fieldLabel: { color: '#C8C7D5', fontSize: 12, fontWeight: '700', marginBottom: 9 },
  input: { backgroundColor: '#020024', borderColor: '#2A2770', borderRadius: 12, borderWidth: 1, color: '#FFFFFF', fontSize: 14, height: 52, paddingHorizontal: 16 },
  inquiryButton: {
    alignItems: 'center',
    backgroundColor: '#1410B4',
    borderColor: '#ED21D9',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    height: 52,
    justifyContent: 'center',
  },
  inquiryButtonDisabled: { opacity: 0.45 },
  inquiryButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  billResultCard: {
    backgroundColor: '#020024',
    borderColor: '#2A2770',
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 12,
    padding: 16,
  },
  billResultHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  billResultLabel: { color: '#C8C7D5', fontSize: 12, fontWeight: '700' },
  billStatusBadge: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5 },
  billStatusPending: { backgroundColor: 'rgba(237, 33, 217, 0.18)' },
  billStatusPaid: { backgroundColor: 'rgba(71, 230, 161, 0.18)' },
  billStatusText: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },
  billAmountText: { color: '#FFFFFF', fontSize: 24, fontWeight: '800', marginTop: 14 },
  billDueText: { color: '#A8A8BA', fontSize: 12, marginTop: 8 },
  fundingRow: { gap: 8 },
  fundingOption: { alignItems: 'center', backgroundColor: 'transparent', borderColor: '#2A2770', borderRadius: 12, borderWidth: 1, flexDirection: 'row', minHeight: 54, padding: 14 },
  fundingOptionSelected: { backgroundColor: 'rgba(20, 16, 180, 0.35)', borderColor: '#ED21D9' },
  fundingLabel: { color: '#FFFFFF', flex: 1, fontSize: 12, fontWeight: '600', marginLeft: 10 },
  radio: { alignItems: 'center', borderColor: '#77788A', borderRadius: 10, borderWidth: 1, height: 20, justifyContent: 'center', width: 20 },
  radioSelected: { borderColor: '#ED21D9' },
  radioDot: { backgroundColor: '#ED21D9', borderRadius: 5, height: 10, width: 10 },
  infoRow: { alignItems: 'center', flexDirection: 'row', marginTop: 25 },
  infoText: { color: '#A8A8BA', flex: 1, fontSize: 11, marginLeft: 8 },
  footer: { paddingHorizontal: 20, paddingBottom: 18 },
  payButton: { borderRadius: 12, elevation: 8, overflow: 'hidden' },
  payButtonDisabled: { opacity: 0.45 },
  payButtonGradient: { alignItems: 'center', flexDirection: 'row', gap: 8, height: 56, justifyContent: 'center' },
  payButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  pressed: { opacity: 0.8 },
  successOverlay: { alignItems: 'center', backgroundColor: 'rgba(4, 2, 104, 0.82)', flex: 1, justifyContent: 'center', padding: 24 },
  successCard: { alignItems: 'center', backgroundColor: '#020024', borderColor: '#2A2770', borderRadius: 24, borderWidth: 1, padding: 24, width: '100%' },
  successIcon: { alignItems: 'center', backgroundColor: '#01B84E', borderRadius: 32, height: 64, justifyContent: 'center', width: 64 },
  successTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '800', marginTop: 16 },
  successText: { color: '#A8A8BA', fontSize: 13, lineHeight: 20, marginTop: 10, textAlign: 'center' },
  successButton: { backgroundColor: '#ED21D9', borderRadius: 12, marginTop: 22, paddingHorizontal: 22, paddingVertical: 14 },
  successButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
});
