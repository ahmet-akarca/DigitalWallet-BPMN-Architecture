import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Category = 'Su' | 'Elektrik' | 'Doğalgaz' | 'İnternet';
type FundingSource = 'wallet' | 'card';

type PaymentInstruction = {
  id: string;
  category: Category;
  title: string;
  subscriberNumber: string;
  status: 'Ödendi' | 'Bakiye Yetersiz';
  enabled: boolean;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  color: string;
};

const CATEGORY_OPTIONS: {
  label: Category;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
}[] = [
  { label: 'Su', icon: 'water' },
  { label: 'Elektrik', icon: 'flash' },
  { label: 'Doğalgaz', icon: 'fire' },
  { label: 'İnternet', icon: 'wifi' },
];

const INITIAL_INSTRUCTIONS: PaymentInstruction[] = [
  {
    id: '1',
    category: 'Elektrik',
    title: 'Ev Elektrik',
    subscriberNumber: 'Abone No: 284 651 09',
    status: 'Ödendi',
    enabled: true,
    icon: 'flash',
    color: '#FFD166',
  },
  {
    id: '2',
    category: 'Su',
    title: 'İSKİ Su',
    subscriberNumber: 'Abone No: 631 904 28',
    status: 'Ödendi',
    enabled: true,
    icon: 'water',
    color: '#46C7FF',
  },
  {
    id: '3',
    category: 'İnternet',
    title: 'Ev İnterneti',
    subscriberNumber: 'Abone No: 100 492 77',
    status: 'Bakiye Yetersiz',
    enabled: false,
    icon: 'wifi',
    color: '#FF6B8A',
  },
];

const categoryIcon = (category: Category) =>
  CATEGORY_OPTIONS.find((option) => option.label === category)?.icon ?? 'receipt';

export default function BillPaymentScreen() {
  const router = useRouter();
  const [instructions, setInstructions] = useState(INITIAL_INSTRUCTIONS);
  const [isSheetVisible, setSheetVisible] = useState(false);
  const [category, setCategory] = useState<Category>('Su');
  const [subscriberNumber, setSubscriberNumber] = useState('');
  const [fundingSource, setFundingSource] = useState<FundingSource>('wallet');
  const [hasLimit, setHasLimit] = useState(false);
  const [limit, setLimit] = useState('');
  const [agreementAccepted, setAgreementAccepted] = useState(false);

  const toggleInstruction = (id: string) => {
    setInstructions((current) =>
      current.map((instruction) =>
        instruction.id === id ? { ...instruction, enabled: !instruction.enabled } : instruction,
      ),
    );
  };

  const saveInstruction = () => {
    if (!subscriberNumber.trim() || !agreementAccepted) return;

    setInstructions((current) => [
      {
        id: Date.now().toString(),
        category,
        title: `${category} Talimatı`,
        subscriberNumber: `Abone No: ${subscriberNumber.trim()}`,
        status: 'Ödendi',
        enabled: true,
        icon: categoryIcon(category),
        color: '#A78BFA',
      },
      ...current,
    ]);
    setSubscriberNumber('');
    setLimit('');
    setHasLimit(false);
    setAgreementAccepted(false);
    setSheetVisible(false);
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
            <Text style={styles.title}>Otomatik Ödemelerim</Text>
          </View>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.summaryCard}>
            <View style={styles.summaryIcon}>
              <MaterialCommunityIcons name="shield-check-outline" size={22} color="#ED21D9" />
            </View>
            <View style={styles.summaryCopy}>
              <Text style={styles.summaryTitle}>Ödemelerin hep zamanında</Text>
              <Text style={styles.summaryText}>Talimatlarını tek yerden kolayca yönet.</Text>
            </View>
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Talimatlarım</Text>
            <Text style={styles.sectionCount}>{instructions.length} kayıt</Text>
          </View>

          {instructions.map((instruction) => (
            <View key={instruction.id} style={styles.instructionCard}>
              <View style={[styles.institutionIcon, { backgroundColor: `${instruction.color}20` }]}>
                <MaterialCommunityIcons name={instruction.icon} size={24} color={instruction.color} />
              </View>
              <View style={styles.instructionCopy}>
                <Text style={styles.instructionTitle}>{instruction.title}</Text>
                <Text style={styles.instructionSubtitle}>{instruction.subscriberNumber}</Text>
                <View
                  style={[
                    styles.statusBadge,
                    instruction.status === 'Ödendi' ? styles.paidBadge : styles.failedBadge,
                  ]}
                >
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: instruction.status === 'Ödendi' ? '#47E6A1' : '#FF6B8A' },
                    ]}
                  />
                  <Text
                    style={[
                      styles.statusText,
                      { color: instruction.status === 'Ödendi' ? '#47E6A1' : '#FF6B8A' },
                    ]}
                  >
                    {instruction.status}
                  </Text>
                </View>
              </View>
              <Switch
                accessibilityLabel={`${instruction.title} talimatını ${instruction.enabled ? 'kapat' : 'aç'}`}
                onValueChange={() => toggleInstruction(instruction.id)}
                trackColor={{ false: '#343544', true: '#8E168D' }}
                thumbColor={instruction.enabled ? '#ED21D9' : '#8A8B9A'}
                value={instruction.enabled}
              />
            </View>
          ))}
        </ScrollView>

        <Pressable
          accessibilityRole="button"
          onPress={() => setSheetVisible(true)}
          style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
        >
          <LinearGradient colors={['#ED21D9', '#970DD9']} style={styles.addButtonGradient}>
            <MaterialCommunityIcons name="plus" size={22} color="#FFFFFF" />
            <Text style={styles.addButtonText}>Yeni Talimat Ekle</Text>
          </LinearGradient>
        </Pressable>
      </SafeAreaView>

      <Modal
        animationType="slide"
        onRequestClose={() => setSheetVisible(false)}
        transparent
        visible={isSheetVisible}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalRoot}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setSheetVisible(false)} />
          <View style={styles.bottomSheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View>
                <Text style={styles.sheetEyebrow}>YENİ TALİMAT</Text>
                <Text style={styles.sheetTitle}>Yeni Talimat Ekle</Text>
              </View>
              <Pressable
                accessibilityLabel="Pencereyi kapat"
                hitSlop={12}
                onPress={() => setSheetVisible(false)}
                style={styles.closeButton}
              >
                <MaterialCommunityIcons name="close" size={20} color="#B5B5C5" />
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.sheetContent} showsVerticalScrollIndicator={false}>
              <Text style={styles.formLabel}>Fatura kategorisi</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRow}>
                {CATEGORY_OPTIONS.map((option) => {
                  const selected = category === option.label;
                  return (
                    <Pressable
                      key={option.label}
                      accessibilityRole="button"
                      onPress={() => setCategory(option.label)}
                      style={[styles.categoryOption, selected && styles.categoryOptionSelected]}
                    >
                      <MaterialCommunityIcons
                        name={option.icon}
                        size={20}
                        color={selected ? '#FFFFFF' : '#A8A8BA'}
                      />
                      <Text style={[styles.categoryText, selected && styles.categoryTextSelected]}>
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <Text style={styles.formLabel}>Abone / Tesisat No</Text>
              <TextInput
                keyboardType="number-pad"
                onChangeText={setSubscriberNumber}
                placeholder="Numarayı girin"
                placeholderTextColor="#77788A"
                style={styles.textInput}
                value={subscriberNumber}
              />

              <Text style={styles.formLabel}>Ödeme kaynağı</Text>
              <View style={styles.fundingRow}>
                {[
                  { value: 'wallet' as const, label: 'Cüzdan Bakiyemden Öde', icon: 'wallet-outline' as const },
                  { value: 'card' as const, label: 'Kayıtlı Karttan Çek', icon: 'credit-card-outline' as const },
                ].map((option) => {
                  const selected = fundingSource === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => setFundingSource(option.value)}
                      style={[styles.fundingCard, selected && styles.fundingCardSelected]}
                    >
                      <MaterialCommunityIcons name={option.icon} size={20} color={selected ? '#ED21D9' : '#A8A8BA'} />
                      <Text style={styles.fundingText}>{option.label}</Text>
                      <View style={[styles.radio, selected && styles.radioSelected]}>
                        {selected && <View style={styles.radioDot} />}
                      </View>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.settingRow}>
                <View>
                  <Text style={styles.settingTitle}>Maksimum Limit Belirle</Text>
                  <Text style={styles.settingSubtitle}>Beklenmeyen tutarlara karşı koruma</Text>
                </View>
                <Switch
                  onValueChange={setHasLimit}
                  trackColor={{ false: '#343544', true: '#8E168D' }}
                  thumbColor={hasLimit ? '#ED21D9' : '#8A8B9A'}
                  value={hasLimit}
                />
              </View>
              {hasLimit && (
                <View style={styles.limitInputWrapper}>
                  <TextInput
                    keyboardType="decimal-pad"
                    onChangeText={setLimit}
                    placeholder="0,00"
                    placeholderTextColor="#77788A"
                    style={styles.limitInput}
                    value={limit}
                  />
                  <Text style={styles.currency}>₺</Text>
                </View>
              )}

              <Pressable onPress={() => setAgreementAccepted((current) => !current)} style={styles.agreementRow}>
                <View style={[styles.checkbox, agreementAccepted && styles.checkboxSelected]}>
                  {agreementAccepted && <MaterialCommunityIcons name="check" size={16} color="#FFFFFF" />}
                </View>
                <Text style={styles.agreementText}>KVKK ve İşlem Onay Metni&apos;ni okudum, onaylıyorum.</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                onPress={saveInstruction}
                style={({ pressed }) => [styles.confirmButton, pressed && styles.pressed]}
              >
                <Text style={styles.confirmText}>Talimatı Kaydet</Text>
                <MaterialCommunityIcons name="arrow-right" size={20} color="#FFFFFF" />
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safeArea: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 20 },
  backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerSpacer: { width: 0 },
  eyebrow: { color: '#FFFFFF', fontSize: 9, fontWeight: '700', letterSpacing: 1.2 },
  title: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', marginTop: 5, marginLeft: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 112 },
  summaryCard: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 18, backgroundColor: '#020024', borderWidth: 1, borderColor: '#2A2770' },
  summaryIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1410B4' },
  summaryCopy: { flex: 1, marginLeft: 12 },
  summaryTitle: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  summaryText: { color: '#9291A5', fontSize: 12, marginTop: 4 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 26, marginBottom: 12 },
  sectionTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  sectionCount: { color: '#858499', fontSize: 12 },
  instructionCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#020024', borderRadius: 20, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#2A2770' },
  institutionIcon: { width: 50, height: 50, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  instructionCopy: { flex: 1, marginHorizontal: 12 },
  instructionTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  instructionSubtitle: { color: '#858499', fontSize: 12, marginTop: 5 },
  statusBadge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4, marginTop: 8 },
  paidBadge: { backgroundColor: '#47E6A112' },
  failedBadge: { backgroundColor: '#FF6B8A12' },
  statusDot: { width: 5, height: 5, borderRadius: 3, marginRight: 5 },
  statusText: { fontSize: 10, fontWeight: '700' },
  addButton: { position: 'absolute', left: 20, right: 20, bottom: 18, borderRadius: 12, overflow: 'hidden', elevation: 8 },
  addButtonGradient: { height: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  addButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  pressed: { opacity: 0.8 },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.68)' },
  bottomSheet: { maxHeight: '92%', backgroundColor: '#05004F', borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingTop: 12 },
  sheetHandle: { width: 60, height: 4, borderRadius: 2, backgroundColor: '#FFFFFF', opacity: 0.5, alignSelf: 'center', marginBottom: 18 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22 },
  sheetEyebrow: { color: '#ED21D9', fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  sheetTitle: { color: '#FFFFFF', fontSize: 22, fontWeight: '800', marginTop: 5 },
  closeButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1410B4' },
  sheetContent: { paddingHorizontal: 22, paddingTop: 24, paddingBottom: 28 },
  formLabel: { color: '#C8C7D5', fontSize: 12, fontWeight: '700', marginBottom: 10, marginTop: 18 },
  categoryRow: { gap: 8 },
  categoryOption: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 13, paddingVertical: 11, borderRadius: 12, backgroundColor: 'transparent', borderWidth: 1, borderColor: '#2A2770' },
  categoryOptionSelected: { backgroundColor: '#1410B4', borderColor: '#ED21D9' },
  categoryText: { color: '#A8A8BA', fontSize: 12, fontWeight: '700' },
  categoryTextSelected: { color: '#FFFFFF' },
  textInput: { height: 52, borderRadius: 12, backgroundColor: '#020024', borderWidth: 1, borderColor: '#2A2770', paddingHorizontal: 16, color: '#FFFFFF', fontSize: 14 },
  fundingRow: { gap: 8 },
  fundingCard: { flexDirection: 'row', alignItems: 'center', padding: 14, minHeight: 54, borderRadius: 12, backgroundColor: 'transparent', borderWidth: 1, borderColor: '#2A2770' },
  fundingCardSelected: { borderColor: '#ED21D9', backgroundColor: 'rgba(20, 16, 180, 0.35)' },
  fundingText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600', flex: 1, marginLeft: 10 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: '#77788A', alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: '#ED21D9' },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#ED21D9' },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 22, paddingVertical: 4 },
  settingTitle: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  settingSubtitle: { color: '#858499', fontSize: 11, marginTop: 4 },
  limitInputWrapper: { flexDirection: 'row', alignItems: 'center', height: 52, borderRadius: 12, backgroundColor: '#020024', borderWidth: 1, borderColor: '#ED21D9', marginTop: 8 },
  limitInput: { flex: 1, color: '#FFFFFF', paddingHorizontal: 16, fontSize: 14 },
  currency: { color: '#ED21D9', fontSize: 16, fontWeight: '800', marginRight: 16 },
  agreementRow: { flexDirection: 'row', alignItems: 'center', marginTop: 22 },
  checkbox: { width: 22, height: 22, borderRadius: 7, borderWidth: 1, borderColor: '#6A687D', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  checkboxSelected: { backgroundColor: '#ED21D9', borderColor: '#ED21D9' },
  agreementText: { color: '#A8A8BA', fontSize: 11, lineHeight: 17, flex: 1 },
  confirmButton: { height: 56, borderRadius: 12, backgroundColor: '#ED21D9', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 24 },
  confirmText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
});
