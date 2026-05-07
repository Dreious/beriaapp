import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { Accelerometer } from 'expo-sensors';
import * as Location from 'expo-location';
import { io } from 'socket.io-client';
import { WebView } from 'react-native-webview';
import { Asset } from 'expo-asset';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FacePresenceCamera, useFacePresenceGuard } from './hooks/useFacePresenceGuard';
import { createQuestionOrder, questions } from './questionBank';
import spanishTurkishWords from './spanishTurkishWords.json';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Easing,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const COURSE_PDF = require('./assets/spanish-full-course.pdf');
const STORY_INTRO_PDF = require('./assets/story-intro.pdf');
const STORY_PDF = require('./assets/spanish-short-stories.pdf');
const COURSE_MIN_PAGE = 1;
const COURSE_MAX_PAGE = 350;
const STORY_INTRO_MAX_PAGE = 14;
const STORY_MIN_PAGE = 300;
const STORY_MAX_PAGE = 1500;
const FACE_DETECTION_FPS = 2;
const NO_FACE_TIMEOUT_MS = 500;
const MOTION_UPDATE_INTERVAL_MS = 80;
const MOTION_DELTA_THRESHOLD = 0.75;
const MOTION_MAGNITUDE_THRESHOLD = 1.85;
const FACE_SCAN_STORAGE_KEY = 'settings.faceScanEnabled';
const DARK_MODE_STORAGE_KEY = 'settings.darkModeEnabled';
const LEAGUE_PLAYERS = [
  { name: 'SofiaSol', xp: 1280, rank: 1, highlight: true },
  { name: 'LunaMora', xp: 1195, rank: 2 },
  { name: 'Canito_34', xp: 1120, rank: 3 },
  { name: 'ElifVista', xp: 980, rank: 4 },
  { name: 'DiegoKaan', xp: 910, rank: 5 },
  { name: 'MaviSol', xp: 840, rank: 6 },
];
const DAILY_TASKS = [
  { title: '10 kelime tekrari', text: 'Kelime kasasini doldur', progress: '6 / 10', tone: 'green' },
  { title: '1 hikaye sayfasi oku', text: 'Kisa hikayeden bir bolum bitir', progress: '0 / 1', tone: 'purple' },
  { title: 'Test serisini koru', text: 'Arka arkaya 3 soru dogru cevapla', progress: '2 / 3', tone: 'blue' },
  { title: 'Calisma hatirlaticisi', text: 'Bugunku Ispanyolca saatini kacirma', progress: 'Hazir', tone: 'gold' },
];

function getApiBaseUrl() {
  const configuredUrl = process.env.EXPO_PUBLIC_API_URL;

  if (configuredUrl) {
    return configuredUrl;
  }

  const hostUri =
    Constants.expoConfig?.hostUri ||
    Constants.manifest2?.extra?.expoClient?.hostUri ||
    Constants.manifest?.debuggerHost ||
    '';
  const host = hostUri.split(':')[0];

  return host ? `http://${host}:4000` : 'http://localhost:4000';
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getMapUrl(location) {
  return `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
}

function getEmbeddedMapUrl(location) {
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  const delta = 0.01;
  const bbox = [
    longitude - delta,
    latitude - delta,
    longitude + delta,
    latitude + delta,
  ].join(',');

  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${latitude},${longitude}`;
}

function normalizeWord(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function getRandomPage(minPage, maxPage) {
  return Math.floor(Math.random() * (maxPage - minPage + 1)) + minPage;
}

async function cancelStudyRemindersAsync() {
  if (Platform.OS === 'web') {
    return;
  }

  await Notifications.cancelAllScheduledNotificationsAsync();
}

async function registerForMessageNotificationsAsync(apiBaseUrl, session) {
  if (Platform.OS === 'web') {
    return;
  }

  const currentPermission = await Notifications.getPermissionsAsync();
  let finalStatus = currentPermission.status;

  if (finalStatus !== 'granted') {
    const requestedPermission = await Notifications.requestPermissionsAsync();
    finalStatus = requestedPermission.status;
  }

  if (finalStatus !== 'granted') {
    return;
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ||
    Constants.easConfig?.projectId;

  const pushToken = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );

  await fetch(`${apiBaseUrl}/push-token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token: pushToken.data }),
  });
}

async function fetchUserSettingsAsync(apiBaseUrl, session) {
  const response = await fetch(`${apiBaseUrl}/user-settings`, {
    headers: {
      Authorization: `Bearer ${session.token}`,
    },
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || 'Ayarlar alinamadi.');
  }

  return data.settings || {};
}

async function saveUserSettingsAsync(apiBaseUrl, session, settings) {
  const response = await fetch(`${apiBaseUrl}/user-settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(settings),
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || 'Ayarlar kaydedilemedi.');
  }

  return data.settings || {};
}

export default function App() {
  const apiBaseUrl = useMemo(getApiBaseUrl, []);
  const [screen, setScreen] = useState('login');
  const [session, setSession] = useState(null);
  const [answers, setAnswers] = useState({});
  const [testOrder, setTestOrder] = useState(() => createQuestionOrder());
  const [testIndex, setTestIndex] = useState(0);
  const [faceScanEnabled, setFaceScanEnabled] = useState(true);
  const [darkModeEnabled, setDarkModeEnabled] = useState(false);
  const [courseStartPage, setCourseStartPage] = useState(null);
  const [storyStartTarget, setStoryStartTarget] = useState(null);

  const firstThreeUnlocked = questions
    .slice(0, 3)
    .every((question) => answers[question.id] === question.correct);

  useEffect(() => {
    let active = true;

    AsyncStorage.getItem(FACE_SCAN_STORAGE_KEY)
      .then((storedValue) => {
        if (active && storedValue !== null) {
          setFaceScanEnabled(storedValue === 'true');
        }
      })
      .catch(() => null);
    AsyncStorage.getItem(DARK_MODE_STORAGE_KEY)
      .then((storedValue) => {
        if (active && storedValue !== null) {
          setDarkModeEnabled(storedValue === 'true');
        }
      })
      .catch(() => null);

    return () => {
      active = false;
    };
  }, []);

  function toggleFaceScanEnabled() {
    setFaceScanEnabled((current) => {
      const nextValue = !current;
      AsyncStorage.setItem(FACE_SCAN_STORAGE_KEY, String(nextValue)).catch(() => null);

      if (session?.token) {
        saveUserSettingsAsync(apiBaseUrl, session, { faceScanEnabled: nextValue }).catch(() => null);
      }

      return nextValue;
    });
  }

  function toggleDarkModeEnabled() {
    setDarkModeEnabled((current) => {
      const nextValue = !current;
      AsyncStorage.setItem(DARK_MODE_STORAGE_KEY, String(nextValue)).catch(() => null);
      return nextValue;
    });
  }

  useEffect(() => {
    if (!session) {
      return undefined;
    }

    let active = true;

    cancelStudyRemindersAsync().catch(() => {
      if (active) {
        // Planli bildirim temizlenemezse uygulama akisini bozma.
      }
    });
    registerForMessageNotificationsAsync(apiBaseUrl, session).catch(() => {
      if (active) {
        // Bildirim izni kapaliysa mesajlasma akisini bozma.
      }
    });
    fetchUserSettingsAsync(apiBaseUrl, session)
      .then((settings) => {
        if (active && typeof settings.faceScanEnabled === 'boolean') {
          setFaceScanEnabled(settings.faceScanEnabled);
          AsyncStorage.setItem(
            FACE_SCAN_STORAGE_KEY,
            String(settings.faceScanEnabled),
          ).catch(() => null);
        }
      })
      .catch(() => null);

    return () => {
      active = false;
    };
  }, [apiBaseUrl, session]);

  function handleLogout() {
    setSession(null);
    setAnswers({});
    setTestOrder(createQuestionOrder());
    setTestIndex(0);
    setScreen('login');
  }

  function getBackScreen() {
    if (session?.user.role === 'admin') {
      return 'adminHome';
    }

    return 'home';
  }

  function openChat() {
    if (session?.user.role === 'admin' || firstThreeUnlocked) {
      setScreen('chat');
      return;
    }

    Alert.alert('Kilitli', 'Ilk uc soruda A, B, C siralamasini tamamla.');
  }

  function handleTestAnswer(questionId, option) {
    const nextAnswers = { ...answers, [questionId]: option };
    const unlocked = questions
      .slice(0, 3)
      .every((question) => nextAnswers[question.id] === question.correct);

    setAnswers(nextAnswers);

    if (unlocked) {
      setScreen('chat');
      return;
    }

    setTestIndex((current) => Math.min(current + 1, testOrder.length));
  }

  function resetTest() {
    setAnswers({});
    setTestOrder(createQuestionOrder());
    setTestIndex(0);
  }

  function openTestScreen() {
    resetTest();
    setScreen('test');
  }

  function openPdfScreen({ randomPage = false } = {}) {
    setCourseStartPage(randomPage ? getRandomPage(COURSE_MIN_PAGE, COURSE_MAX_PAGE) : null);
    setScreen('pdf');
  }

  function openStoryScreen({ randomPage = false } = {}) {
    setStoryStartTarget(
      randomPage
        ? { book: 'intro', page: STORY_INTRO_MAX_PAGE }
        : { book: 'intro', page: 1 },
    );
    setScreen('story');
  }

  function openRandomReadingScreen() {
    if (Math.random() < 0.5) {
      openPdfScreen({ randomPage: true });
      return;
    }

    openStoryScreen({ randomPage: true });
  }

  function leaveCurrentScreen() {
    if (screen === 'test') {
      resetTest();
    }

    setScreen(getBackScreen());
  }

  const chatNavigation = useMemo(
    () => ({
      canGoBack: () => screen === 'chat',
      goBack: openRandomReadingScreen,
      replace: (routeName) => {
        if (routeName === 'Home' || routeName === 'home') {
          openRandomReadingScreen();
          return;
        }

        if (routeName === 'AdminHome' || routeName === 'adminHome') {
          setScreen('adminHome');
          return;
        }

        setScreen(routeName);
      },
    }),
    [screen, session?.user.role],
  );

  return (
    <SafeAreaView style={[styles.shell, darkModeEnabled && styles.shellDark]}>
      <StatusBar style="light" />
      {session?.user.role === 'user' ? (
        <>
          <LocationReporter apiBaseUrl={apiBaseUrl} session={session} />
          <UserStatusReporter apiBaseUrl={apiBaseUrl} session={session} />
        </>
      ) : null}
      {screen !== 'login' ? (
        <Header
          darkModeEnabled={darkModeEnabled}
          title={session?.user.role === 'admin' ? 'Admin Paneli' : 'Calisma'}
          onBack={screen === 'home' || screen === 'adminHome' ? null : leaveCurrentScreen}
          onLogout={handleLogout}
          onSettings={screen === 'settings' ? null : () => setScreen('settings')}
        />
      ) : null}

      {screen === 'login' ? (
        <LoginScreen apiBaseUrl={apiBaseUrl} onLogin={(nextSession) => {
          setSession(nextSession);
          setScreen(nextSession.user.role === 'admin' ? 'adminHome' : 'home');
        }} />
      ) : null}

      {screen === 'adminHome' ? (
        <GamifiedAdminHomeScreen
          apiBaseUrl={apiBaseUrl}
          darkModeEnabled={darkModeEnabled}
          session={session}
          onOpenChat={() => setScreen('chat')}
          onOpenLocations={() => setScreen('locations')}
        />
      ) : null}

      {screen === 'home' ? (
        <GamifiedHomeScreen
          darkModeEnabled={darkModeEnabled}
          faceScanEnabled={faceScanEnabled}
          onOpenPdf={() => openPdfScreen()}
          onOpenSettings={() => setScreen('settings')}
          onOpenStory={() => openStoryScreen()}
          onOpenTest={openTestScreen}
        />
      ) : null}

      {screen === 'pdf' ? <PdfScreen darkModeEnabled={darkModeEnabled} initialPage={courseStartPage} /> : null}

      {screen === 'settings' ? (
        <SettingsScreen
          darkModeEnabled={darkModeEnabled}
          faceScanEnabled={faceScanEnabled}
          onToggleDarkMode={toggleDarkModeEnabled}
          onToggleFaceScan={toggleFaceScanEnabled}
        />
      ) : null}

      {screen === 'story' ? (
        <StoryScreen darkModeEnabled={darkModeEnabled} initialTarget={storyStartTarget} />
      ) : null}

      {screen === 'test' ? (
        <GamifiedTestScreen
          darkModeEnabled={darkModeEnabled}
          currentAnswer={testOrder[testIndex] ? answers[testOrder[testIndex].id] : null}
          currentQuestion={testOrder[testIndex] || null}
          isChatUnlocked={firstThreeUnlocked}
          onAnswer={handleTestAnswer}
          onOpenChat={openChat}
          onReset={resetTest}
          questionNumber={testOrder[testIndex] ? testIndex + 1 : testOrder.length}
          totalQuestions={testOrder.length}
        />
      ) : null}

      {screen === 'chat' && session ? (
        <ChatScreen
          apiBaseUrl={apiBaseUrl}
          darkModeEnabled={darkModeEnabled}
          faceScanEnabled={faceScanEnabled}
          navigation={chatNavigation}
          session={session}
          onMotionDetected={openRandomReadingScreen}
        />
      ) : null}

      {screen === 'locations' && session ? (
        <LocationScreen apiBaseUrl={apiBaseUrl} session={session} />
      ) : null}
    </SafeAreaView>
  );
}

function Header({ darkModeEnabled, title, onBack, onLogout, onSettings }) {
  return (
    <View style={[styles.header, darkModeEnabled && styles.headerDark]}>
      <Pressable
        style={[styles.iconButton, !onBack && styles.hiddenButton]}
        onPress={onBack}
        disabled={!onBack}
      >
        <Text style={styles.iconText}>{'<'}</Text>
      </Pressable>
      <Text style={styles.headerTitle}>{title}</Text>
      <Pressable
        style={[styles.settingsButton, !onSettings && styles.hiddenButton]}
        onPress={onSettings}
        disabled={!onSettings}
      >
        <Text style={styles.settingsText}>Ayar</Text>
      </Pressable>
      <Pressable style={styles.logoutButton} onPress={onLogout}>
        <Text style={styles.logoutText}>Cikis</Text>
      </Pressable>
    </View>
  );
}

function LoginScreen({ apiBaseUrl, onLogin }) {
  const [role, setRole] = useState('user');
  const [username, setUsername] = useState('ogrenci');
  const [password, setPassword] = useState('123456');
  const [adminMode, setAdminMode] = useState(false);
  const [loading, setLoading] = useState(false);

  function openAdminMode() {
    setAdminMode(true);
    setRole('admin');
    setUsername('');
    setPassword('');
  }

  function openStudentMode() {
    setAdminMode(false);
    setRole('user');
    setUsername('ogrenci');
    setPassword('123456');
  }

  async function login() {
    setLoading(true);

    try {
      const response = await fetch(`${apiBaseUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password, role }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Giris basarisiz.');
      }

      onLogin(data);
    } catch (error) {
      Alert.alert('Giris yapilamadi', error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.loginWrap}
    >
      <View style={styles.loginDecorOne} />
      <View style={styles.loginDecorTwo} />

      <Pressable style={styles.adminMiniButton} onPress={adminMode ? openStudentMode : openAdminMode}>
        <Text style={styles.adminMiniText}>{adminMode ? 'Ogrenci' : 'Admin girisi'}</Text>
      </Pressable>

      <View style={styles.loginMascotCard}>
        <View style={styles.loginMascotCircle}>
          <Text style={styles.loginMascotText}>B</Text>
        </View>
        <View style={styles.loginMascotCopy}>
          <Text style={styles.loginMiniBadge}>{adminMode ? 'KONTROL PANELI' : 'BERIVAN DEMO'}</Text>
          <Text style={styles.appTitle}>{adminMode ? 'Admin Girisi' : 'Hola Berivan'}</Text>
          <Text style={styles.appSubtitle}>
            {adminMode
              ? 'Admin paneline gecmek icin kullanici adi ve sifre gir.'
              : 'Ispanyolca gorevlerine devam et, serini kaybetme.'}
          </Text>
        </View>
      </View>

      <View style={styles.loginPanel}>
        <View style={styles.loginRewardRow}>
          <View style={styles.loginRewardPill}>
            <Text style={styles.loginRewardValue}>7</Text>
            <Text style={styles.loginRewardLabel}>Seri</Text>
          </View>
          <View style={styles.loginRewardPillBlue}>
            <Text style={styles.loginRewardValue}>1280</Text>
            <Text style={styles.loginRewardLabel}>XP</Text>
          </View>
          <View style={styles.loginRewardPillRed}>
            <Text style={styles.loginRewardValue}>5</Text>
            <Text style={styles.loginRewardLabel}>Can</Text>
          </View>
        </View>

        {adminMode ? (
          <>
            <TextInput
              autoCapitalize="none"
              value={username}
              onChangeText={setUsername}
              placeholder="admin"
              placeholderTextColor="#8b93a7"
              style={styles.input}
            />
            <TextInput
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              placeholder="Admin123"
              placeholderTextColor="#8b93a7"
              style={styles.input}
            />
          </>
        ) : (
          <View style={styles.studentWelcomeCard}>
            <Text style={styles.studentWelcomeTitle}>Berivan hazir</Text>
            <Text style={styles.studentWelcomeText}>
              Hikaye, test, PDF ve gunluk gorevlerin tek dokunusta acilacak.
            </Text>
          </View>
        )}

        <PrimaryButton
          disabled={loading}
          label={loading ? 'Giris yapiliyor' : adminMode ? 'Admin Paneline Gir' : 'Calismaya Basla'}
          onPress={login}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

function HomeScreen({ isChatUnlocked, onOpenPdf, onOpenTest, onOpenChat }) {
  return (
    <View style={styles.content}>
      <Text style={styles.pageTitle}>Calisma Alani</Text>
      <Text style={styles.pageLead}>PDF okuyup testi cozdükten sonra adminle yazisabilirsin.</Text>

      <View style={styles.actionGrid}>
        <ActionTile title="PDF Oku" text="Ders dokumanini ac" onPress={onOpenPdf} />
        <ActionTile title="Test Coz" text="A, B, C kilidini tamamla" onPress={onOpenTest} />
        <ActionTile
          title="Admin Chat"
          text={isChatUnlocked ? 'Yazisma acik' : 'Ilk 3 soru gerekli'}
          locked={!isChatUnlocked}
          onPress={onOpenChat}
        />
      </View>
    </View>
  );
}

function AdminHomeScreen({ onOpenChat, onOpenLocations }) {
  return (
    <View style={styles.content}>
      <Text style={styles.pageTitle}>Admin Paneli</Text>
      <Text style={styles.pageLead}>Yazismalari ve kullanicinin son konumunu buradan takip edebilirsin.</Text>

      <View style={styles.actionGrid}>
        <ActionTile title="Chat" text="Kullanici ile yazis" onPress={onOpenChat} />
        <ActionTile title="Konum" text="Son konumu haritada ac" onPress={onOpenLocations} />
      </View>
    </View>
  );
}

function PdfScreen({ darkModeEnabled, initialPage }) {
  const [courseUri, setCourseUri] = useState(null);
  const courseSourceUri = courseUri && initialPage ? `${courseUri}#page=${initialPage}` : courseUri;

  useEffect(() => {
    let active = true;

    async function loadCourse() {
      const asset = Asset.fromModule(COURSE_PDF);
      await asset.downloadAsync();

      if (active) {
        setCourseUri(asset.localUri || asset.uri);
      }
    }

    loadCourse().catch(() => {
      if (active) {
        setCourseUri(null);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  return (
    <View style={[styles.pdfScreen, darkModeEnabled && styles.darkScreen]}>
      <View style={[styles.pdfToolbar, darkModeEnabled && styles.darkToolbar]}>
        <Text style={[styles.pdfTitle, darkModeEnabled && styles.darkTitle]}>Ders PDF</Text>
        {courseUri ? (
          <Pressable style={styles.smallButton} onPress={() => Linking.openURL(courseUri)}>
            <Text style={styles.smallButtonText}>Disarda Ac</Text>
          </Pressable>
        ) : null}
      </View>
      {courseUri ? (
        <WebView
          key={courseSourceUri}
          originWhitelist={['*']}
          source={{ uri: courseSourceUri }}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.webLoading}>
              <ActivityIndicator color="#58cc02" />
            </View>
          )}
        />
      ) : (
        <View style={styles.webLoading}>
          <ActivityIndicator color="#58cc02" />
        </View>
      )}
    </View>
  );
}

function StoryScreen({ darkModeEnabled, initialTarget }) {
  const [introStoryUri, setIntroStoryUri] = useState(null);
  const [mainStoryUri, setMainStoryUri] = useState(null);
  const [storyBook, setStoryBook] = useState(initialTarget?.book || 'intro');
  const [query, setQuery] = useState('');
  const [storyPage, setStoryPage] = useState(
    () => initialTarget?.page || 1,
  );
  const [pageInput, setPageInput] = useState('');
  const [showPageInput, setShowPageInput] = useState(false);
  const normalizedQuery = normalizeWord(query);
  const dictionary = useMemo(() => {
    return new Map(spanishTurkishWords.map((entry) => [entry.normalized, entry]));
  }, []);
  const exactMatch = normalizedQuery ? dictionary.get(normalizedQuery) : null;
  const suggestions = useMemo(() => {
    if (!normalizedQuery || exactMatch) {
      return [];
    }

    return spanishTurkishWords
      .filter((entry) =>
        entry.normalized.startsWith(normalizedQuery) ||
        entry.normalized.includes(normalizedQuery)
      )
      .slice(0, 5);
  }, [exactMatch, normalizedQuery]);
  const activeStoryUri = storyBook === 'intro' ? introStoryUri : mainStoryUri;
  const storySourceUri = activeStoryUri ? `${activeStoryUri}#page=${storyPage}` : null;

  function changeStoryPage(amount) {
    setStoryPage((current) => {
      const nextPage = current + amount;

      if (storyBook === 'intro' && nextPage > STORY_INTRO_MAX_PAGE) {
        setStoryBook('main');
        return STORY_MIN_PAGE;
      }

      if (storyBook === 'main' && nextPage < STORY_MIN_PAGE) {
        setStoryBook('intro');
        return STORY_INTRO_MAX_PAGE;
      }

      return Math.max(1, nextPage);
    });
  }

  function openTypedPage() {
    const nextPage = Number.parseInt(pageInput, 10);

    if (!Number.isFinite(nextPage) || nextPage < 1) {
      Alert.alert('Sayfa gecersiz', 'Gecerli bir sayfa numarasi yaz.');
      return;
    }

    setStoryPage(nextPage);
    setPageInput('');
    setShowPageInput(false);
  }

  function openNextStoryBook() {
    setStoryBook('main');
    setStoryPage(STORY_MIN_PAGE);
  }

  useEffect(() => {
    let active = true;

    async function loadStoryAssets() {
      const introAsset = Asset.fromModule(STORY_INTRO_PDF);
      const mainAsset = Asset.fromModule(STORY_PDF);
      await Promise.all([introAsset.downloadAsync(), mainAsset.downloadAsync()]);

      if (active) {
        setIntroStoryUri(introAsset.localUri || introAsset.uri);
        setMainStoryUri(mainAsset.localUri || mainAsset.uri);
      }
    }

    loadStoryAssets().catch(() => {
      if (active) {
        setIntroStoryUri(null);
        setMainStoryUri(null);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  return (
    <View style={[styles.storyScreen, darkModeEnabled && styles.darkScreen]}>
      <View style={styles.storyHeader}>
        <View style={[styles.storyTranslator, darkModeEnabled && styles.darkPanel]}>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            value={query}
            onChangeText={setQuery}
            placeholder="Hikayedeki Ispanyolca kelime"
            placeholderTextColor="#8b93a7"
            style={styles.translateInput}
          />

          {exactMatch ? (
            <View style={styles.translationResultCompact}>
              <Text style={styles.translationWord}>{exactMatch.spanish}</Text>
              <Text style={styles.translationMeaning}>{exactMatch.turkish}</Text>
            </View>
          ) : null}

          {!exactMatch && normalizedQuery ? (
            <Text style={styles.storyLead}>Kelime bulunamadi. Onerilerden birini sec.</Text>
          ) : null}

          {suggestions.length > 0 ? (
            <View style={styles.suggestionList}>
              {suggestions.map((entry) => (
                <Pressable
                  key={entry.rank}
                  style={styles.suggestionItem}
                  onPress={() => setQuery(entry.spanish)}
                >
                  <Text style={styles.suggestionWord}>{entry.spanish}</Text>
                  <Text style={styles.suggestionMeaning}>{entry.turkish}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </View>

      <View style={styles.storyBook}>
        {activeStoryUri ? (
          <WebView
            key={storySourceUri}
            originWhitelist={['*']}
            source={{ uri: storySourceUri }}
            startInLoadingState
            style={styles.storyWebView}
            renderLoading={() => (
              <View style={styles.webLoading}>
                <ActivityIndicator color="#58cc02" />
              </View>
            )}
          />
        ) : (
          <View style={styles.storyLoading}>
            <ActivityIndicator color="#58cc02" />
            <Text style={styles.storyLead}>Hikaye hazirlaniyor.</Text>
          </View>
        )}
      </View>

      <View style={styles.pageJumpBox}>
        {showPageInput ? (
          <>
            <TextInput
              keyboardType="number-pad"
              value={pageInput}
              onChangeText={setPageInput}
              placeholder="Sayfa"
              placeholderTextColor="#8b93a7"
              style={styles.pageJumpInput}
            />
            <Pressable style={styles.pageJumpButton} onPress={openTypedPage}>
              <Text style={styles.pageJumpButtonText}>Git</Text>
            </Pressable>
            <Pressable style={styles.pageStepButton} onPress={() => setShowPageInput(false)}>
              <Text style={styles.pageJumpButtonText}>X</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable style={styles.pageStepButton} onPress={() => changeStoryPage(-10)}>
              <Text style={styles.pageJumpButtonText}>-10</Text>
            </Pressable>
            <Pressable style={styles.pageStepButton} onPress={() => changeStoryPage(-1)}>
              <Text style={styles.pageJumpButtonText}>-</Text>
            </Pressable>
            <Text style={styles.pageNumberText}>{storyPage}</Text>
            <Pressable style={styles.pageStepButton} onPress={() => changeStoryPage(1)}>
              <Text style={styles.pageJumpButtonText}>+</Text>
            </Pressable>
            <Pressable style={styles.pageStepButton} onPress={() => changeStoryPage(10)}>
              <Text style={styles.pageJumpButtonText}>+10</Text>
            </Pressable>
            <Pressable style={styles.pageJumpButton} onPress={() => setShowPageInput(true)}>
              <Text style={styles.pageJumpButtonText}>Sayfa Yaz</Text>
            </Pressable>
            {storyBook === 'intro' ? (
              <Pressable style={styles.pageJumpButton} onPress={openNextStoryBook}>
                <Text style={styles.pageJumpButtonText}>Devam PDF</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

function TestScreen({
  currentAnswer,
  currentQuestion,
  isChatUnlocked,
  onAnswer,
  onOpenChat,
  onReset,
  questionNumber,
  totalQuestions,
}) {
  return (
    <ScrollView contentContainerStyle={styles.testContent}>
      <View style={styles.quizBanner}>
        <View>
          <Text style={styles.courseBadge}>ARENA</Text>
          <Text style={styles.pageTitle}>Test Cozme</Text>
          <Text style={styles.pageLead}>Ilk 3 cevap A, B, C olursa gizli gorev acilir.</Text>
        </View>
        <View style={styles.quizGem}>
          <Text style={styles.quizGemText}>{questionNumber}</Text>
        </View>
      </View>
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            { width: `${Math.min((questionNumber / totalQuestions) * 100, 100)}%` },
          ]}
        />
      </View>

      {currentQuestion ? (
        <View style={styles.questionCard}>
          <Text style={styles.questionStep}>{questionNumber} / {totalQuestions}</Text>
          <Text style={styles.questionTitle}>{currentQuestion.title}</Text>
          <Text style={styles.questionPrompt}>{currentQuestion.prompt}</Text>
          <View style={styles.optionRow}>
            {currentQuestion.options.map((option) => {
              const selected = currentAnswer === option.key;
              return (
                <Pressable
                  key={option.key}
                  style={[styles.optionButton, selected && styles.optionButtonSelected]}
                  onPress={() => onAnswer(currentQuestion.id, option.key)}
                >
                  <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                    {option.key}. {option.text}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : (
        <View style={styles.questionCard}>
          <Text style={styles.questionTitle}>Test Tamamlandi</Text>
          <Text style={styles.questionPrompt}>
            Ilk 3 soru A, B, C sirasi ile dogru cevaplanmadigi icin yazisma bolumu acilmadi.
            Yeni rastgele sirayla tekrar deneyebilirsin.
          </Text>
          <PrimaryButton label="Tekrar Dene" onPress={onReset} />
        </View>
      )}

      {isChatUnlocked ? (
        <PrimaryButton
          label="Yazisma Bolumune Git"
          onPress={onOpenChat}
        />
      ) : null}
    </ScrollView>
  );
}

function GamifiedHomeScreen({
  faceScanEnabled,
  onOpenPdf,
  onOpenStory,
  onOpenTest,
}) {
  const floatAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const floatLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(floatAnim, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 900,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 900,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );

    floatLoop.start();
    pulseLoop.start();

    return () => {
      floatLoop.stop();
      pulseLoop.stop();
    };
  }, [floatAnim, pulseAnim]);

  const floatingStyle = {
    transform: [
      {
        translateY: floatAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -8],
        }),
      },
    ],
  };
  const pulseStyle = {
    opacity: pulseAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [0.45, 1],
    }),
    transform: [
      {
        scale: pulseAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [0.9, 1.18],
        }),
      },
    ],
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Animated.View style={[styles.heroBand, floatingStyle]}>
        <View style={styles.heroCopy}>
          <Text style={styles.courseBadge}>BERIVAN</Text>
          <Text style={styles.pageTitle}>Hola, Berivan</Text>
          <Text style={styles.pageLead}>Bugunku Ispanyolca rotan hazir. Dersleri tamamla, seri rozetini koru.</Text>
        </View>
        <View style={styles.mascotBubble}>
          <Text style={styles.mascotText}>B</Text>
        </View>
      </Animated.View>

      <View style={styles.statsRow}>
        <StatPill label="Seri" value="7" tone="orange" />
        <StatPill label="XP" value="1280" tone="blue" />
        <StatPill label="Can" value="5" tone="red" />
      </View>

      <View style={styles.profileStrip}>
        <View style={styles.profileAvatar}>
          <Text style={styles.profileAvatarText}>BE</Text>
        </View>
        <View style={styles.profileCopy}>
          <Text style={styles.profileName}>Berivan'in Panosu</Text>
          <Text style={styles.profileMeta}>B1 hedefi • Gunluk 20 dakika • 64% ilerleme</Text>
        </View>
        <View style={styles.profileBadge}>
          <Text style={styles.profileBadgeText}>PRO</Text>
        </View>
      </View>

      <View style={styles.fakeNavBar}>
        <FakeNavItem active label="Dersler" />
        <FakeNavItem label="Lig" />
        <FakeNavItem label="Gorevler" />
        <FakeNavItem label="Profil" />
      </View>

      <View style={styles.homeShowcaseGrid}>
        <View style={styles.leaguePanel}>
          <View style={styles.panelHeaderRow}>
            <Text style={styles.panelEyebrow}>LIG</Text>
            <Text style={styles.panelBadge}>Altin</Text>
          </View>
          <Text style={styles.panelTitle}>Haftalik Sira</Text>
          {LEAGUE_PLAYERS.map((player) => (
            <View
              key={player.name}
              style={[styles.leagueRow, player.highlight && styles.leagueRowHighlight]}
            >
              <Text style={[styles.leagueRank, player.highlight && styles.leagueRankHighlight]}>
                #{player.rank}
              </Text>
              <View style={styles.leagueAvatar}>
                <Text style={styles.leagueAvatarText}>{player.name.slice(0, 2).toUpperCase()}</Text>
              </View>
              <Text style={[styles.leagueName, player.highlight && styles.leagueNameHighlight]}>
                {player.name}
              </Text>
              <Text style={styles.leagueXp}>{player.xp} XP</Text>
            </View>
          ))}
        </View>

        <View style={styles.tasksPanel}>
          <View style={styles.panelHeaderRow}>
            <Text style={styles.panelEyebrow}>GOREVLER</Text>
            <Text style={styles.panelBadge}>Gunluk</Text>
          </View>
          <Text style={styles.panelTitle}>Berivan'in Listesi</Text>
          {DAILY_TASKS.map((task) => (
            <View key={task.title} style={[styles.taskCard, styles[`taskCard${task.tone}`]]}>
              <View style={styles.taskIcon}>
                <Text style={styles.taskIconText}>+</Text>
              </View>
              <View style={styles.taskCopy}>
                <Text style={styles.taskTitle}>{task.title}</Text>
                <Text style={styles.taskText}>{task.text}</Text>
              </View>
              <Text style={styles.taskProgress}>{task.progress}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.lessonPath}>
        <View style={styles.pathLine} />
        <Animated.View style={[styles.sparkleOne, pulseStyle]} />
        <Animated.View style={[styles.sparkleTwo, pulseStyle]} />
        <LessonNode
          align="left"
          reward="10 XP"
          step="1"
          title="PDF Oku"
          text="Ders notlarini ac"
          tone="green"
          onPress={onOpenPdf}
        />
        <LessonNode
          align="right"
          reward="Hikaye"
          step="2"
          title="Hikaye Oku"
          text="Kisa Ispanyolca hikayeler"
          tone="purple"
          onPress={onOpenStory}
        />
        <View style={styles.chapterRibbon}>
          <Text style={styles.chapterRibbonText}>Kilit gorevi yaklasiyor</Text>
        </View>
        <LessonNode
          align="left"
          reward="100 soru"
          step="3"
          title="Test Coz"
          text="Ilk 3 cevap A, B, C"
          tone="blue"
          onPress={onOpenTest}
        />
        <View style={styles.chapterRibbon}>
          <Text style={styles.chapterRibbonText}>Bonus adasi</Text>
        </View>
        <LessonNode
          align="right"
          decorative
          reward="Yakinda"
          step="4"
          title="Dinleme"
          text="Telaffuz gorevi"
          tone="red"
        />
        <LessonNode
          align="left"
          decorative
          reward="Rozet"
          step="5"
          title="Kelime Avı"
          text="Seri odulu"
          tone="gold"
        />
        <LessonNode
          align="right"
          decorative
          reward="Lig"
          step="6"
          title="Liderlik"
          text="Haftalik siralama"
          tone="green"
        />
        <View style={styles.demoGrid}>
          <DemoFeatureCard title="Rozet Kasasi" text="12 rozet toplandi" tone="gold" />
          <DemoFeatureCard title="Kelime Serisi" text="84 kelime tekrarlandi" tone="green" />
          <DemoFeatureCard title="Berivan Ligi" text="3. siradasin" tone="blue" />
          <DemoFeatureCard title="Haftalik Plan" text="5 ders bekliyor" tone="purple" />
        </View>
      </View>
    </ScrollView>
  );
}

function SettingsScreen({ darkModeEnabled, faceScanEnabled, onToggleDarkMode, onToggleFaceScan }) {
  return (
    <ScrollView contentContainerStyle={[styles.content, darkModeEnabled && styles.contentDark]}>
      <View style={[styles.heroBand, darkModeEnabled && styles.darkPanel]}>
        <View style={styles.heroCopy}>
          <Text style={styles.courseBadge}>AYARLAR</Text>
          <Text style={styles.pageTitle}>Chat Ayarlari</Text>
          <Text style={styles.pageLead}>Chat ekraninda kamera ile yuz varligi kontrolunu yonet.</Text>
        </View>
        <View style={[styles.mascotBubble, styles.adminMascotBubble]}>
          <Text style={styles.mascotText}>⚙</Text>
        </View>
      </View>

      <View style={styles.settingRow}>
        <View style={styles.settingCopy}>
          <Text style={styles.tileTitle}>Yuz tarama</Text>
          <Text style={styles.tileText}>
            {faceScanEnabled
              ? 'Chat acilinca on kamera yuz varligini kontrol eder.'
              : 'Chat ekraninda kamera ile yuz kontrolu yapilmaz.'}
          </Text>
        </View>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: faceScanEnabled }}
          style={[styles.switchTrack, faceScanEnabled && styles.switchTrackOn]}
          onPress={onToggleFaceScan}
        >
          <View style={[styles.switchThumb, faceScanEnabled && styles.switchThumbOn]} />
        </Pressable>
      </View>

      <SettingPreview title="Bildirimler" text="Mesaj ve ders hatirlaticilari acik" enabled />
      <SettingPreview title="Ses efektleri" text="Buton ve gorev sesleri" enabled />
      <SettingPreview title="Gunluk hedef" text="10 dakika calisma hedefi" enabled />
      <SettingPreview
        title="Karanlik mod"
        text="Arayuzu koyu tema ile kullan"
        enabled={darkModeEnabled}
        onPress={onToggleDarkMode}
      />
      <SettingPreview title="Lig siralamasi" text="Haftalik XP yarisi" enabled />
      <SettingPreview title="Veri tasarrufu" text="Gorsel efektleri azalt" />
    </ScrollView>
  );
}

function GamifiedAdminHomeScreen({ apiBaseUrl, session, onOpenChat, onOpenLocations }) {
  const [userStatuses, setUserStatuses] = useState([]);
  const latestStatus = userStatuses[0] || null;

  useEffect(() => {
    if (!session?.token) {
      return undefined;
    }

    let active = true;

    async function fetchStatuses() {
      try {
        const response = await fetch(`${apiBaseUrl}/user-statuses`, {
          headers: {
            Authorization: `Bearer ${session.token}`,
          },
        });
        const data = await response.json();

        if (active) {
          setUserStatuses(data.statuses || []);
        }
      } catch (error) {
        if (active) {
          setUserStatuses([]);
        }
      }
    }

    fetchStatuses();
    const intervalId = setInterval(fetchStatuses, 3000);

    const socket = io(apiBaseUrl, {
      auth: { token: session.token },
    });

    socket.on('connect', fetchStatuses);
    socket.on('user-statuses', (statuses) => {
      setUserStatuses(statuses || []);
    });
    socket.on('user-status-updated', (status) => {
      setUserStatuses((current) => {
        const withoutSameUser = current.filter((item) => item.user.id !== status.user.id);
        return [status, ...withoutSameUser];
      });
    });

    return () => {
      active = false;
      clearInterval(intervalId);
      socket.disconnect();
    };
  }, [apiBaseUrl, session?.token]);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.heroBand}>
        <View style={styles.heroCopy}>
          <Text style={styles.courseBadge}>ADMIN</Text>
          <Text style={styles.pageTitle}>Kontrol Merkezi</Text>
          <Text style={styles.pageLead}>Yazismalari ve son konumu hizli gorevlerden takip et.</Text>
        </View>
        <View style={[styles.mascotBubble, styles.adminMascotBubble]}>
          <Text style={styles.mascotText}>AD</Text>
        </View>
      </View>

      <View style={styles.actionGrid}>
        <ActionTile title="Chat" text="Kullanici ile yazis" onPress={onOpenChat} />
        <ActionTile title="Konum" text="Son konumu haritada ac" onPress={onOpenLocations} />
      </View>

      <View style={styles.adminStatusPanel}>
        <View style={styles.panelHeaderRow}>
          <Text style={styles.panelEyebrow}>KULLANICI DURUMU</Text>
          <Text style={styles.panelBadge}>Canli</Text>
        </View>
        {latestStatus ? (
          <>
            <View style={styles.adminStatusTopRow}>
              <View
                style={[
                  styles.statusDot,
                  latestStatus.isOnline && latestStatus.appState === 'active' && styles.statusDotOnline,
                ]}
              />
              <Text style={styles.adminStatusName}>{latestStatus.user.displayName}</Text>
              <Text style={styles.adminStatusState}>{latestStatus.label}</Text>
            </View>
            <Text style={styles.adminStatusNote}>{latestStatus.note}</Text>
            <Text style={styles.adminStatusMeta}>
              Son gorulme: {formatTime(latestStatus.lastSeenAt)}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.adminStatusName}>Berivan bekleniyor</Text>
            <Text style={styles.adminStatusNote}>
              Kullanici uygulamaya girince aktif/arka plan bilgisi burada gorunecek.
            </Text>
          </>
        )}
      </View>
    </ScrollView>
  );
}

function GamifiedTestScreen({
  currentAnswer,
  currentQuestion,
  isChatUnlocked,
  onAnswer,
  onOpenChat,
  onReset,
  questionNumber,
  totalQuestions,
}) {
  const progress = Math.min((questionNumber / totalQuestions) * 100, 100);

  return (
    <ScrollView contentContainerStyle={styles.testContent}>
      <Text style={styles.courseBadge}>KISA DERS</Text>
      <Text style={styles.pageTitle}>Test Cozme</Text>
      <Text style={styles.pageLead}>
        Ilk 3 soru A, B, C sirasi ile dogru cevaplanirsa yazisma bolumu acilir.
        Yanlis cevap verirsen test 100 soruluk rastgele sirayla devam eder.
      </Text>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${progress}%` }]} />
      </View>

      {currentQuestion ? (
        <View style={styles.questionCard}>
          <Text style={styles.questionStep}>{questionNumber} / {totalQuestions}</Text>
          <Text style={styles.questionTitle}>{currentQuestion.title}</Text>
          <Text style={styles.questionPrompt}>{currentQuestion.prompt}</Text>
          <View style={styles.optionRow}>
            {currentQuestion.options.map((option) => {
              const selected = currentAnswer === option.key;
              return (
                <Pressable
                  key={option.key}
                  style={[styles.optionButton, selected && styles.optionButtonSelected]}
                  onPress={() => onAnswer(currentQuestion.id, option.key)}
                >
                  <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                    {option.key}. {option.text}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : (
        <View style={styles.questionCard}>
          <Text style={styles.questionTitle}>Test Tamamlandi</Text>
          <Text style={styles.questionPrompt}>
            Ilk 3 soru A, B, C sirasi ile dogru cevaplanmadigi icin yazisma bolumu acilmadi.
            Yeni rastgele sirayla tekrar deneyebilirsin.
          </Text>
          <PrimaryButton label="Tekrar Dene" onPress={onReset} />
        </View>
      )}

      {isChatUnlocked ? (
        <PrimaryButton
          label="Yazisma Bolumune Git"
          onPress={onOpenChat}
        />
      ) : null}
    </ScrollView>
  );
}

function LocationReporter({ apiBaseUrl, session }) {
  useEffect(() => {
    let active = true;
    let intervalId = null;

    async function sendCurrentLocation() {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();

        if (!active || permission.status !== 'granted') {
          return;
        }

        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        if (!active) {
          return;
        }

        await fetch(`${apiBaseUrl}/location`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          }),
        });
      } catch (error) {
        // Konum izni veya cihaz konumu kapaliysa uygulama akisini bozma.
      }
    }

    sendCurrentLocation();
    intervalId = setInterval(sendCurrentLocation, 10000);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [apiBaseUrl, session.token]);

  return null;
}

function UserStatusReporter({ apiBaseUrl, session }) {
  useEffect(() => {
    let active = true;
    let currentAppState = AppState.currentState;
    let intervalId = null;

    async function sendStatus(nextAppState = currentAppState) {
      try {
        const appState = nextAppState === 'active' ? 'active' : 'background';

        await fetch(`${apiBaseUrl}/user-status`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ appState }),
        });
      } catch (error) {
        // Durum takibi demo bilgisidir; hata olursa uygulama akisini bozma.
      }
    }

    sendStatus(currentAppState);
    intervalId = setInterval(() => {
      if (active) {
        sendStatus(currentAppState);
      }
    }, 3000);

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      currentAppState = nextAppState;
      sendStatus(nextAppState);
    });

    return () => {
      active = false;
      clearInterval(intervalId);
      subscription.remove();
    };
  }, [apiBaseUrl, session.token]);

  return null;
}

function LocationScreen({ apiBaseUrl, session }) {
  const [locations, setLocations] = useState([]);
  const [connected, setConnected] = useState(false);
  const latestLocation = locations[0] || null;

  useEffect(() => {
    let active = true;

    async function fetchLocations() {
      try {
        const response = await fetch(`${apiBaseUrl}/locations`, {
          headers: {
            Authorization: `Bearer ${session.token}`,
          },
        });
        const data = await response.json();

        if (active) {
          setLocations(data.locations || []);
        }
      } catch (error) {
        if (active) {
          setLocations([]);
        }
      }
    }

    fetchLocations();

    const socket = io(apiBaseUrl, {
      auth: { token: session.token },
    });

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('location-updated', (location) => {
      setLocations((current) => {
        const withoutSameUser = current.filter((item) => item.user.id !== location.user.id);
        return [location, ...withoutSameUser];
      });
    });

    return () => {
      active = false;
      socket.disconnect();
    };
  }, [apiBaseUrl, session.token]);

  return (
    <View style={styles.locationScreen}>
      <LocationMap location={latestLocation} />

      <View style={styles.locationLivePill}>
        <View style={[styles.statusDot, connected && styles.statusDotOnline]} />
        <Text style={styles.statusText}>{connected ? 'Canli' : 'Baglaniyor'}</Text>
      </View>

      <View style={styles.locationSheet}>
        {latestLocation ? (
          <>
            <Text style={styles.locationName}>{latestLocation.user.displayName}</Text>
            <Text style={styles.locationMeta}>
              {latestLocation.latitude.toFixed(5)}, {latestLocation.longitude.toFixed(5)}
            </Text>
            <Text style={styles.locationMeta}>
              Son guncelleme: {formatTime(latestLocation.updatedAt)}
            </Text>
            <Pressable
              style={styles.primaryButton}
              onPress={() => Linking.openURL(getMapUrl(latestLocation))}
            >
              <Text style={styles.primaryButtonText}>Google Maps'te Ac</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.locationName}>Konum bekleniyor</Text>
            <Text style={styles.locationMeta}>
              Kullanici uygulamayi acip konum izni verdiginde burada harita uzerinde gorunecek.
            </Text>
          </>
        )}
      </View>
    </View>
  );
}

function LocationMap({ location }) {
  if (!location) {
    return (
      <View style={styles.mapPlaceholder}>
        <Text style={styles.mapPlaceholderTitle}>Harita hazir</Text>
        <Text style={styles.mapPlaceholderText}>Canli konum geldiginde burada isaretlenecek.</Text>
      </View>
    );
  }

  const mapUrl = getEmbeddedMapUrl(location);

  if (Platform.OS === 'web') {
    return (
      <View style={styles.mapFrame}>
        <iframe
          title="Kullanici konumu"
          src={mapUrl}
          style={{ border: 0, height: '100%', width: '100%' }}
        />
      </View>
    );
  }

  return (
    <View style={styles.mapFrame}>
      <WebView source={{ uri: mapUrl }} style={styles.mapWebView} />
    </View>
  );
}

function AdminChatStatusCard({ status }) {
  if (!status) {
    return (
      <View style={styles.adminChatStatusCard}>
        <View style={styles.panelHeaderRow}>
          <Text style={styles.panelEyebrow}>KULLANICI DURUMU</Text>
          <Text style={styles.panelBadge}>Canli</Text>
        </View>
        <Text style={styles.adminStatusName}>Berivan bekleniyor</Text>
        <Text style={styles.adminStatusNote}>
          Kullanici uygulamaya girince aktif/arka plan bilgisi burada gorunecek.
        </Text>
      </View>
    );
  }

  const isActive = status.isOnline && status.appState === 'active';

  return (
    <View style={styles.adminChatStatusCard}>
      <View style={styles.panelHeaderRow}>
        <Text style={styles.panelEyebrow}>KULLANICI DURUMU</Text>
        <Text style={styles.panelBadge}>Canli</Text>
      </View>
      <View style={styles.adminStatusTopRow}>
        <View style={[styles.statusDot, isActive && styles.statusDotOnline]} />
        <Text style={styles.adminStatusName}>{status.user.displayName}</Text>
        <Text style={styles.adminStatusState}>{status.label}</Text>
      </View>
      <Text style={styles.adminStatusNote}>{status.note}</Text>
      <Text style={styles.adminStatusMeta}>Son gorulme: {formatTime(status.lastSeenAt)}</Text>
    </View>
  );
}

function ChatScreen({ apiBaseUrl, faceScanEnabled, navigation, session, onMotionDetected }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [connected, setConnected] = useState(false);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [typingUsers, setTypingUsers] = useState([]);
  const [chatUserStatus, setChatUserStatus] = useState(null);
  const socketRef = useRef(null);
  const motionLockedRef = useRef(false);
  const typingTimeoutRef = useRef(null);
  const handleFaceGuardExit = useCallback((reason) => {
    if (reason === 'face') {
      Alert.alert('Chat kapatildi', 'Kamera: 0.5 saniye boyunca yuz algilanmadi.');
      return;
    }

    if (reason === 'background') {
      Alert.alert('Chat kapatildi', 'Uygulama arka plana alindigi icin chat kapatildi.');
    }
  }, []);
  const faceGuard = useFacePresenceGuard({
    detectionFps: FACE_DETECTION_FPS,
    enabled: faceScanEnabled && Platform.OS !== 'web',
    navigation,
    noFaceTimeoutMs: NO_FACE_TIMEOUT_MS,
    onExit: handleFaceGuardExit,
  });

  useEffect(() => {
    if (!faceGuard.canEnterChat) {
      return undefined;
    }

    let active = true;

    fetch(`${apiBaseUrl}/messages`, {
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    })
      .then((response) => response.json())
      .then((data) => {
        if (active) {
          setMessages(data.messages || []);
        }
      })
      .catch(() => null);

    if (session.user.role === 'admin') {
      fetch(`${apiBaseUrl}/user-statuses`, {
        headers: {
          Authorization: `Bearer ${session.token}`,
        },
      })
        .then((response) => response.json())
        .then((data) => {
          if (active) {
            setChatUserStatus((data.statuses || [])[0] || null);
          }
        })
        .catch(() => null);
    }

    const socket = io(apiBaseUrl, {
      auth: { token: session.token },
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('chat-history', (history) => setMessages(history));
    socket.on('user-statuses', (statuses) => {
      if (session.user.role === 'admin') {
        setChatUserStatus((statuses || [])[0] || null);
      }
    });
    socket.on('user-status-updated', (status) => {
      if (session.user.role === 'admin') {
        setChatUserStatus(status);
      }
    });
    socket.on('message', (message) => {
      setMessages((current) => {
        if (current.some((item) => item.id === message.id)) {
          return current;
        }

        return [...current, message];
      });
    });
    socket.on('messages-read', ({ messageIds, readerId }) => {
      setMessages((current) =>
        current.map((message) => {
          if (!messageIds.includes(message.id)) {
            return message;
          }

          const readBy = message.readBy || [];
          return {
            ...message,
            readBy: readBy.includes(readerId) ? readBy : [...readBy, readerId],
          };
        }),
      );
    });
    socket.on('typing', ({ user, isTyping }) => {
      if (!user || user.id === session.user.id) {
        return;
      }

      setTypingUsers((current) => {
        const withoutUser = current.filter((item) => item.id !== user.id);
        return isTyping ? [...withoutUser, user] : withoutUser;
      });
    });

    return () => {
      active = false;
      clearTimeout(typingTimeoutRef.current);
      socket.disconnect();
    };
  }, [apiBaseUrl, faceGuard.canEnterChat, session.token, session.user.id, session.user.role]);

  useEffect(() => {
    const unreadIds = messages
      .filter((message) => message.sender.id !== session.user.id)
      .filter((message) => !(message.readBy || []).includes(session.user.id))
      .map((message) => message.id);

    if (unreadIds.length > 0 && connected && socketRef.current?.connected) {
      socketRef.current.emit('mark-read', { messageIds: unreadIds });
    }
  }, [connected, messages, session.user.id]);

  useEffect(() => {
    if (
      Platform.OS === 'web' ||
      !faceGuard.canEnterChat ||
      session.user.role !== 'user' ||
      typeof Accelerometer?.addListener !== 'function'
    ) {
      return undefined;
    }

    let lastMagnitude = null;
    Accelerometer.setUpdateInterval?.(MOTION_UPDATE_INTERVAL_MS);
    const subscription = Accelerometer.addListener(({ x, y, z }) => {
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      const delta = lastMagnitude === null ? 0 : Math.abs(magnitude - lastMagnitude);
      lastMagnitude = magnitude;

      if (
        !motionLockedRef.current &&
        (delta > MOTION_DELTA_THRESHOLD || magnitude > MOTION_MAGNITUDE_THRESHOLD)
      ) {
        motionLockedRef.current = true;
        Alert.alert('Chat kapatildi', 'Hareket sensoru: ani hareket algilandi.');
        onMotionDetected();
      }
    });

    return () => subscription.remove();
  }, [faceGuard.canEnterChat, onMotionDetected, session.user.role]);

  function handleTextChange(value) {
    setText(value);

    if (!socketRef.current) {
      return;
    }

    socketRef.current.emit('typing', { isTyping: value.trim().length > 0 });
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socketRef.current?.emit('typing', { isTyping: false });
    }, 1200);
  }

  function sendMessage() {
    const nextText = text.trim();

    if (!nextText || !socketRef.current) {
      return;
    }

    socketRef.current.emit('typing', { isTyping: false });
    socketRef.current.emit('send-message', { text: nextText }, (result) => {
      if (!result?.ok) {
        Alert.alert('Mesaj gonderilemedi', result?.message || 'Tekrar dene.');
      }
    });
    setText('');
  }

  async function pickAndSendPhoto() {
    if (!socketRef.current || isUploadingPhoto) {
      return;
    }

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (permission.status !== 'granted') {
        Alert.alert('Izin gerekli', 'Fotoğraf gonderebilmek icin galeri izni gerekiyor.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: false,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.82,
      });

      if (result.canceled || !result.assets?.[0]) {
        return;
      }

      setIsUploadingPhoto(true);
      const asset = result.assets[0];
      const extension = (asset.uri.split('.').pop() || 'jpg').split('?')[0];
      const mimeType = asset.mimeType || `image/${extension === 'jpg' ? 'jpeg' : extension}`;
      const formData = new FormData();

      if (Platform.OS === 'web' && asset.file) {
        formData.append('photo', asset.file);
      } else {
        formData.append('photo', {
          uri: asset.uri,
          name: `chat-photo.${extension}`,
          type: mimeType,
        });
      }

      const response = await fetch(`${apiBaseUrl}/attachments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
        },
        body: formData,
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Fotoğraf yuklenemedi.');
      }

      socketRef.current.emit('typing', { isTyping: false });
      socketRef.current.emit('send-message', { attachment: data.attachment }, (result) => {
        if (!result?.ok) {
          Alert.alert('Fotoğraf gonderilemedi', result?.message || 'Tekrar dene.');
        }
      });
    } catch (error) {
      Alert.alert('Fotoğraf gonderilemedi', error.message || 'Tekrar dene.');
    } finally {
      setIsUploadingPhoto(false);
    }
  }

  if (!faceGuard.canEnterChat) {
    return (
      <View style={styles.guardNotice}>
        <Text style={styles.guardTitle}>Kamera izni gerekli</Text>
        <Text style={styles.guardText}>
          {faceGuard.permissionRequested
            ? faceGuard.guardMessage
            : 'Kamera izni kontrol ediliyor.'}
        </Text>
        <Pressable style={styles.primaryButton} onPress={faceGuard.requestPermission}>
          <Text style={styles.primaryButtonText}>Izin ver</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
      style={styles.chatScreen}
    >
      <FacePresenceCamera guard={faceGuard} style={styles.faceGuardCamera} />

      {session.user.role === 'admin' ? (
        <AdminChatStatusCard status={chatUserStatus} />
      ) : null}

      <View style={styles.chatStatus}>
        <View style={[styles.statusDot, connected && styles.statusDotOnline]} />
        <Text style={styles.statusText}>{connected ? 'Bagli' : 'Baglaniyor'}</Text>
        {typingUsers.length > 0 ? (
          <Text style={styles.locationStatus}>{typingUsers[0].displayName} yaziyor...</Text>
        ) : null}
      </View>

      <FlatList
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messageList}
        renderItem={({ item }) => {
          const mine = item.sender.id === session.user.id;
          const readByOther = (item.readBy || []).some((userId) => userId !== item.sender.id);
          return (
            <View style={[styles.messageBubble, mine ? styles.myMessage : styles.theirMessage]}>
              <Text style={styles.messageSender}>
                {item.sender.displayName} · {formatTime(item.createdAt)}
                {mine ? ` ${readByOther ? '✓✓' : '✓'}` : ''}
              </Text>
              {item.attachment?.type === 'image' ? (
                <Pressable onPress={() => Linking.openURL(item.attachment.url)}>
                  <Image source={{ uri: item.attachment.url }} style={styles.messageImage} />
                  <Text style={styles.attachmentMeta}>1 saat sonra silinir</Text>
                </Pressable>
              ) : null}
              {item.text ? <Text style={styles.messageText}>{item.text}</Text> : null}
              {item.location && session.user.role === 'admin' ? (
                <Pressable
                  style={styles.locationLink}
                  onPress={() => Linking.openURL(getMapUrl(item.location))}
                >
                  <Text style={styles.locationLinkText}>
                    Konumu ac: {item.location.latitude.toFixed(5)}, {item.location.longitude.toFixed(5)}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={<Text style={styles.emptyChat}>Henuz mesaj yok.</Text>}
      />

      <View style={styles.composer}>
        <Pressable
          disabled={isUploadingPhoto}
          style={[styles.photoButton, isUploadingPhoto && styles.primaryButtonDisabled]}
          onPress={pickAndSendPhoto}
        >
          <Text style={styles.photoButtonText}>{isUploadingPhoto ? '...' : '+'}</Text>
        </Pressable>
        <TextInput
          value={text}
          onChangeText={handleTextChange}
          placeholder="Mesaj yaz"
          placeholderTextColor="#8b93a7"
          style={styles.messageInput}
        />
        <Pressable style={styles.sendButton} onPress={sendMessage}>
          <Text style={styles.sendButtonText}>Gonder</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function ActionTile({ title, text, locked, onPress }) {
  return (
    <Pressable style={[styles.tile, locked && styles.lockedTile]} onPress={onPress}>
      <Text style={styles.tileTitle}>{title}</Text>
      <Text style={styles.tileText}>{text}</Text>
    </Pressable>
  );
}

function StatPill({ label, value, tone }) {
  return (
    <View style={[styles.statPill, styles[`statPill${tone}`]]}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function FakeNavItem({ active, label }) {
  return (
    <View style={[styles.fakeNavItem, active && styles.fakeNavItemActive]}>
      <View style={[styles.fakeNavDot, active && styles.fakeNavDotActive]} />
      <Text style={[styles.fakeNavLabel, active && styles.fakeNavLabelActive]}>{label}</Text>
    </View>
  );
}

function DemoFeatureCard({ text, title, tone }) {
  return (
    <View style={[styles.demoFeatureCard, styles[`demoFeature${tone}`]]}>
      <Text style={styles.demoFeatureTitle}>{title}</Text>
      <Text style={styles.demoFeatureText}>{text}</Text>
    </View>
  );
}

function LessonNode({ align = 'left', decorative, locked, onPress, reward, step, text, title, tone }) {
  return (
    <Pressable
      disabled={locked || decorative || !onPress}
      style={[
        styles.lessonNode,
        align === 'right' && styles.lessonNodeRight,
        decorative && styles.lessonNodeDecorative,
        locked && styles.lessonNodeLocked,
      ]}
      onPress={onPress}
    >
      <View style={[styles.lessonOrb, styles[`lessonOrb${tone}`], locked && styles.lessonOrbLocked]}>
        <Text style={styles.lessonOrbText}>{locked ? '?' : step}</Text>
      </View>
      <View style={styles.lessonPanel}>
        {reward ? <Text style={styles.lessonReward}>{reward}</Text> : null}
        <Text style={styles.tileTitle}>{title}</Text>
        <Text style={styles.tileText}>{text}</Text>
      </View>
    </Pressable>
  );
}

function SettingPreview({ enabled, onPress, text, title }) {
  const Container = onPress ? Pressable : View;

  return (
    <Container style={styles.settingRow} onPress={onPress}>
      <View style={styles.settingCopy}>
        <Text style={styles.tileTitle}>{title}</Text>
        <Text style={styles.tileText}>{text}</Text>
      </View>
      <View style={[styles.switchTrack, enabled && styles.switchTrackOn, styles.previewSwitch]}>
        <View style={[styles.switchThumb, enabled && styles.switchThumbOn]} />
      </View>
    </Container>
  );
}

function PrimaryButton({ label, disabled, onPress }) {
  return (
    <Pressable
      disabled={disabled}
      style={[styles.primaryButton, disabled && styles.primaryButtonDisabled]}
      onPress={onPress}
    >
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: '#f6fff1',
  },
  shellDark: {
    backgroundColor: '#101820',
  },
  header: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7f0ce',
    borderBottomWidth: 2,
    flexDirection: 'row',
    gap: 12,
    minHeight: 62,
    paddingHorizontal: 16,
  },
  headerDark: {
    backgroundColor: '#17212b',
    borderBottomColor: '#263746',
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: '#eefbe8',
    borderColor: '#58cc02',
    borderRadius: 18,
    borderWidth: 2,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  hiddenButton: {
    opacity: 0,
  },
  iconText: {
    color: '#58cc02',
    fontSize: 30,
    lineHeight: 32,
  },
  headerTitle: {
    color: '#3c3c3c',
    flex: 1,
    fontSize: 18,
    fontWeight: '900',
    textAlign: 'center',
  },
  logoutButton: {
    alignItems: 'center',
    backgroundColor: '#fff5f5',
    borderColor: '#ff4b4b',
    borderRadius: 18,
    borderWidth: 2,
    height: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  settingsButton: {
    alignItems: 'center',
    backgroundColor: '#eefbe8',
    borderColor: '#58cc02',
    borderRadius: 18,
    borderWidth: 2,
    height: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  settingsText: {
    color: '#58a700',
    fontSize: 13,
    fontWeight: '900',
  },
  logoutText: {
    color: '#ff4b4b',
    fontSize: 13,
    fontWeight: '900',
  },
  loginWrap: {
    backgroundColor: '#eaffdf',
    flex: 1,
    justifyContent: 'center',
    overflow: 'hidden',
    padding: 20,
  },
  loginDecorOne: {
    backgroundColor: '#58cc02',
    borderRadius: 80,
    height: 160,
    opacity: 0.18,
    position: 'absolute',
    right: -42,
    top: 76,
    transform: [{ rotate: '-12deg' }],
    width: 160,
  },
  loginDecorTwo: {
    backgroundColor: '#1cb0f6',
    borderRadius: 70,
    bottom: 58,
    height: 140,
    left: -52,
    opacity: 0.16,
    position: 'absolute',
    transform: [{ rotate: '18deg' }],
    width: 140,
  },
  adminMiniButton: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 4,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 9,
    position: 'absolute',
    right: 16,
    top: 18,
    zIndex: 2,
  },
  adminMiniText: {
    color: '#58a700',
    fontSize: 12,
    fontWeight: '900',
  },
  loginMascotCard: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 6,
    borderRadius: 28,
    flexDirection: 'row',
    gap: 14,
    marginBottom: 14,
    padding: 18,
  },
  loginMascotCircle: {
    alignItems: 'center',
    backgroundColor: '#58cc02',
    borderBottomColor: '#46a302',
    borderBottomWidth: 6,
    borderRadius: 42,
    height: 84,
    justifyContent: 'center',
    transform: [{ rotate: '-6deg' }],
    width: 84,
  },
  loginMascotText: {
    color: '#ffffff',
    fontSize: 38,
    fontWeight: '900',
  },
  loginMascotCopy: {
    flex: 1,
  },
  loginMiniBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#fff4c2',
    borderRadius: 999,
    color: '#a66d00',
    fontSize: 11,
    fontWeight: '900',
    marginBottom: 7,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  loginPanel: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 6,
    borderRadius: 24,
    gap: 14,
    padding: 18,
  },
  appTitle: {
    color: '#3c3c3c',
    fontSize: 30,
    fontWeight: '900',
  },
  appSubtitle: {
    color: '#526070',
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 20,
  },
  loginRewardRow: {
    flexDirection: 'row',
    gap: 10,
  },
  loginRewardPill: {
    alignItems: 'center',
    backgroundColor: '#fff4c2',
    borderBottomColor: '#ffc800',
    borderBottomWidth: 5,
    borderRadius: 18,
    flex: 1,
    paddingVertical: 10,
  },
  loginRewardPillBlue: {
    alignItems: 'center',
    backgroundColor: '#d8f1ff',
    borderBottomColor: '#1cb0f6',
    borderBottomWidth: 5,
    borderRadius: 18,
    flex: 1,
    paddingVertical: 10,
  },
  loginRewardPillRed: {
    alignItems: 'center',
    backgroundColor: '#ffe5e5',
    borderBottomColor: '#ff4b4b',
    borderBottomWidth: 5,
    borderRadius: 18,
    flex: 1,
    paddingVertical: 10,
  },
  loginRewardValue: {
    color: '#3c3c3c',
    fontSize: 18,
    fontWeight: '900',
  },
  loginRewardLabel: {
    color: '#6b7280',
    fontSize: 11,
    fontWeight: '900',
  },
  studentWelcomeCard: {
    backgroundColor: '#ddf8d2',
    borderBottomColor: '#58cc02',
    borderBottomWidth: 5,
    borderRadius: 20,
    padding: 16,
  },
  studentWelcomeTitle: {
    color: '#3c3c3c',
    fontSize: 18,
    fontWeight: '900',
    marginBottom: 5,
  },
  studentWelcomeText: {
    color: '#526070',
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 19,
  },
  input: {
    backgroundColor: '#f9fbf7',
    borderColor: '#d7d7d7',
    borderRadius: 18,
    borderWidth: 2,
    color: '#111827',
    fontSize: 16,
    fontWeight: '800',
    minHeight: 52,
    paddingHorizontal: 14,
  },
  serverHint: {
    color: '#667085',
    fontSize: 12,
    textAlign: 'center',
  },
  content: {
    flexGrow: 1,
    gap: 16,
    padding: 20,
    paddingBottom: 34,
  },
  contentDark: {
    backgroundColor: '#101820',
  },
  darkScreen: {
    backgroundColor: '#101820',
  },
  darkPanel: {
    backgroundColor: '#17212b',
    borderBottomColor: '#263746',
    borderColor: '#263746',
  },
  darkToolbar: {
    backgroundColor: '#17212b',
    borderBottomColor: '#263746',
  },
  darkTitle: {
    color: '#f5f7fb',
  },
  pageTitle: {
    color: '#3c3c3c',
    fontSize: 28,
    fontWeight: '900',
    marginBottom: 8,
  },
  pageLead: {
    color: '#6b7280',
    fontSize: 15,
    lineHeight: 22,
  },
  courseBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#ddf8d2',
    borderRadius: 999,
    color: '#58a700',
    fontSize: 12,
    fontWeight: '900',
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  heroBand: {
    alignItems: 'center',
    backgroundColor: '#fff7d6',
    borderBottomColor: '#f1c232',
    borderBottomWidth: 5,
    borderRadius: 24,
    flexDirection: 'row',
    gap: 14,
    padding: 18,
  },
  heroCopy: {
    flex: 1,
  },
  mascotBubble: {
    alignItems: 'center',
    backgroundColor: '#58cc02',
    borderBottomColor: '#46a302',
    borderBottomWidth: 5,
    borderRadius: 32,
    height: 64,
    justifyContent: 'center',
    transform: [{ rotate: '-6deg' }],
    width: 64,
  },
  adminMascotBubble: {
    backgroundColor: '#1cb0f6',
    borderBottomColor: '#168ac0',
  },
  mascotText: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '900',
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  statPill: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderBottomWidth: 4,
    borderRadius: 18,
    flex: 1,
    paddingVertical: 11,
  },
  statPillorange: {
    borderBottomColor: '#e69a00',
  },
  statPillblue: {
    borderBottomColor: '#1cb0f6',
  },
  statPillred: {
    borderBottomColor: '#ff4b4b',
  },
  statValue: {
    color: '#3c3c3c',
    fontSize: 18,
    fontWeight: '900',
  },
  statLabel: {
    color: '#7a7a7a',
    fontSize: 11,
    fontWeight: '900',
  },
  profileStrip: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 5,
    borderRadius: 22,
    flexDirection: 'row',
    gap: 12,
    padding: 14,
  },
  profileAvatar: {
    alignItems: 'center',
    backgroundColor: '#ce82ff',
    borderBottomColor: '#a95bd7',
    borderBottomWidth: 4,
    borderRadius: 24,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  profileAvatarText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '900',
  },
  profileCopy: {
    flex: 1,
  },
  profileName: {
    color: '#3c3c3c',
    fontSize: 18,
    fontWeight: '900',
  },
  profileMeta: {
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 3,
  },
  profileBadge: {
    backgroundColor: '#ffc800',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  profileBadgeText: {
    color: '#7a5200',
    fontSize: 11,
    fontWeight: '900',
  },
  fakeNavBar: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 5,
    borderRadius: 24,
    flexDirection: 'row',
    gap: 6,
    padding: 8,
  },
  fakeNavItem: {
    alignItems: 'center',
    borderRadius: 18,
    flex: 1,
    gap: 5,
    paddingVertical: 9,
  },
  fakeNavItemActive: {
    backgroundColor: '#ddf8d2',
  },
  fakeNavDot: {
    backgroundColor: '#cfd6dd',
    borderRadius: 6,
    height: 12,
    width: 12,
  },
  fakeNavDotActive: {
    backgroundColor: '#58cc02',
  },
  fakeNavLabel: {
    color: '#7a7a7a',
    fontSize: 11,
    fontWeight: '900',
  },
  fakeNavLabelActive: {
    color: '#58a700',
  },
  homeShowcaseGrid: {
    gap: 12,
  },
  leaguePanel: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 5,
    borderRadius: 22,
    gap: 8,
    padding: 14,
  },
  tasksPanel: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 5,
    borderRadius: 22,
    gap: 10,
    padding: 14,
  },
  panelHeaderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  panelEyebrow: {
    color: '#58a700',
    fontSize: 12,
    fontWeight: '900',
  },
  panelBadge: {
    backgroundColor: '#fff4c2',
    borderRadius: 999,
    color: '#a66d00',
    fontSize: 11,
    fontWeight: '900',
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  panelTitle: {
    color: '#3c3c3c',
    fontSize: 18,
    fontWeight: '900',
  },
  leagueRow: {
    alignItems: 'center',
    backgroundColor: '#f7fafc',
    borderRadius: 16,
    flexDirection: 'row',
    gap: 9,
    minHeight: 46,
    paddingHorizontal: 10,
  },
  leagueRowHighlight: {
    backgroundColor: '#ddf8d2',
  },
  leagueRank: {
    color: '#8b93a7',
    fontSize: 13,
    fontWeight: '900',
    width: 30,
  },
  leagueRankHighlight: {
    color: '#58a700',
  },
  leagueAvatar: {
    alignItems: 'center',
    backgroundColor: '#1cb0f6',
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  leagueAvatarText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '900',
  },
  leagueName: {
    color: '#3c3c3c',
    flex: 1,
    fontSize: 14,
    fontWeight: '900',
  },
  leagueNameHighlight: {
    color: '#58a700',
  },
  leagueXp: {
    color: '#f2a541',
    fontSize: 12,
    fontWeight: '900',
  },
  taskCard: {
    alignItems: 'center',
    borderBottomWidth: 4,
    borderRadius: 16,
    flexDirection: 'row',
    gap: 10,
    minHeight: 58,
    padding: 10,
  },
  taskCardgreen: {
    backgroundColor: '#eefbe8',
    borderBottomColor: '#58cc02',
  },
  taskCardpurple: {
    backgroundColor: '#f1dcff',
    borderBottomColor: '#ce82ff',
  },
  taskCardblue: {
    backgroundColor: '#d8f1ff',
    borderBottomColor: '#1cb0f6',
  },
  taskCardgold: {
    backgroundColor: '#fff4c2',
    borderBottomColor: '#ffc800',
  },
  taskIcon: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  taskIconText: {
    color: '#58a700',
    fontSize: 20,
    fontWeight: '900',
    lineHeight: 22,
  },
  taskCopy: {
    flex: 1,
  },
  taskTitle: {
    color: '#3c3c3c',
    fontSize: 14,
    fontWeight: '900',
  },
  taskText: {
    color: '#6b7280',
    fontSize: 11,
    fontWeight: '800',
    marginTop: 2,
  },
  taskProgress: {
    color: '#3c3c3c',
    fontSize: 12,
    fontWeight: '900',
  },
  adminStatusPanel: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 5,
    borderRadius: 22,
    gap: 10,
    padding: 16,
  },
  adminChatStatusCard: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 5,
    borderRadius: 0,
    gap: 9,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  adminStatusTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
  },
  adminStatusName: {
    color: '#3c3c3c',
    flex: 1,
    fontSize: 18,
    fontWeight: '900',
  },
  adminStatusState: {
    color: '#58a700',
    fontSize: 12,
    fontWeight: '900',
  },
  adminStatusNote: {
    color: '#526070',
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 20,
  },
  adminStatusMeta: {
    color: '#8b93a7',
    fontSize: 12,
    fontWeight: '900',
  },
  lessonPath: {
    gap: 14,
    minHeight: 430,
    paddingVertical: 8,
  },
  pathLine: {
    backgroundColor: '#b9e9ff',
    bottom: 40,
    left: '49%',
    position: 'absolute',
    top: 34,
    transform: [{ rotate: '8deg' }],
    width: 10,
  },
  sparkleOne: {
    backgroundColor: '#ffc800',
    borderRadius: 12,
    height: 24,
    position: 'absolute',
    right: 26,
    top: 20,
    transform: [{ rotate: '18deg' }],
    width: 24,
  },
  sparkleTwo: {
    backgroundColor: '#ff4b4b',
    borderRadius: 9,
    height: 18,
    left: 18,
    position: 'absolute',
    top: 210,
    transform: [{ rotate: '-18deg' }],
    width: 18,
  },
  lessonNode: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    width: '88%',
  },
  lessonNodeRight: {
    alignSelf: 'flex-end',
  },
  lessonNodeDecorative: {
    opacity: 0.82,
  },
  lessonNodeLocked: {
    opacity: 0.64,
  },
  lessonOrb: {
    alignItems: 'center',
    borderBottomWidth: 5,
    borderRadius: 34,
    height: 68,
    justifyContent: 'center',
    transform: [{ rotate: '-5deg' }],
    width: 68,
  },
  lessonOrbgreen: {
    backgroundColor: '#58cc02',
    borderBottomColor: '#46a302',
  },
  lessonOrbblue: {
    backgroundColor: '#1cb0f6',
    borderBottomColor: '#168ac0',
  },
  lessonOrbred: {
    backgroundColor: '#ff4b4b',
    borderBottomColor: '#d93c3c',
  },
  lessonOrbpurple: {
    backgroundColor: '#ce82ff',
    borderBottomColor: '#a95bd7',
  },
  lessonOrbgold: {
    backgroundColor: '#ffc800',
    borderBottomColor: '#d99d00',
  },
  lessonOrbLocked: {
    backgroundColor: '#cfd6dd',
    borderBottomColor: '#aab3bd',
  },
  lessonOrbText: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '900',
  },
  lessonPanel: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 4,
    borderRadius: 18,
    flex: 1,
    padding: 14,
  },
  lessonReward: {
    alignSelf: 'flex-start',
    backgroundColor: '#eefbe8',
    borderRadius: 999,
    color: '#58a700',
    fontSize: 11,
    fontWeight: '900',
    marginBottom: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chapterRibbon: {
    alignSelf: 'center',
    backgroundColor: '#ce82ff',
    borderBottomColor: '#a95bd7',
    borderBottomWidth: 5,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
    transform: [{ rotate: '-2deg' }],
  },
  chapterRibbonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '900',
  },
  demoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 4,
  },
  demoFeatureCard: {
    borderBottomWidth: 5,
    borderRadius: 18,
    minHeight: 86,
    padding: 12,
    width: '48%',
  },
  demoFeaturegold: {
    backgroundColor: '#fff4c2',
    borderBottomColor: '#d99d00',
  },
  demoFeaturegreen: {
    backgroundColor: '#ddf8d2',
    borderBottomColor: '#58cc02',
  },
  demoFeatureblue: {
    backgroundColor: '#d8f1ff',
    borderBottomColor: '#1cb0f6',
  },
  demoFeaturepurple: {
    backgroundColor: '#f1dcff',
    borderBottomColor: '#ce82ff',
  },
  demoFeatureTitle: {
    color: '#3c3c3c',
    fontSize: 15,
    fontWeight: '900',
    marginBottom: 6,
  },
  demoFeatureText: {
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '800',
  },
  settingRow: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 5,
    borderRadius: 22,
    flexDirection: 'row',
    gap: 14,
    padding: 16,
  },
  settingCopy: {
    flex: 1,
  },
  switchTrack: {
    backgroundColor: '#cfd6dd',
    borderBottomColor: '#aab3bd',
    borderBottomWidth: 4,
    borderRadius: 999,
    height: 40,
    justifyContent: 'center',
    paddingHorizontal: 4,
    width: 70,
  },
  switchTrackOn: {
    backgroundColor: '#58cc02',
    borderBottomColor: '#46a302',
  },
  switchThumb: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    height: 32,
    width: 32,
  },
  switchThumbOn: {
    alignSelf: 'flex-end',
  },
  previewSwitch: {
    opacity: 0.72,
  },
  actionGrid: {
    gap: 12,
  },
  tile: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 5,
    borderRadius: 18,
    minHeight: 96,
    justifyContent: 'center',
    padding: 16,
  },
  lockedTile: {
    borderLeftColor: '#f2a541',
    opacity: 0.78,
  },
  tileTitle: {
    color: '#3c3c3c',
    fontSize: 20,
    fontWeight: '900',
    marginBottom: 6,
  },
  tileText: {
    color: '#526070',
    fontSize: 14,
  },
  pdfScreen: {
    backgroundColor: '#ffffff',
    flex: 1,
  },
  storyScreen: {
    backgroundColor: '#f6fff1',
    flex: 1,
    padding: 10,
  },
  storyHeader: {
    gap: 10,
    marginBottom: 8,
  },
  storyTitle: {
    color: '#3c3c3c',
    fontSize: 24,
    fontWeight: '900',
  },
  storyLead: {
    color: '#6b7280',
    fontSize: 14,
    fontWeight: '800',
    marginTop: 4,
  },
  storyBook: {
    backgroundColor: '#ffffff',
    borderColor: '#e5e5e5',
    borderRadius: 22,
    borderWidth: 2,
    flex: 1,
    overflow: 'hidden',
  },
  storyWebView: {
    backgroundColor: '#ffffff',
    flex: 1,
  },
  storyLoading: {
    alignItems: 'center',
    flex: 1,
    gap: 12,
    justifyContent: 'center',
  },
  pageJumpBox: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginTop: 12,
  },
  pageJumpInput: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 4,
    borderColor: '#e5e5e5',
    borderRadius: 18,
    borderWidth: 2,
    color: '#3c3c3c',
    flex: 1,
    fontSize: 16,
    fontWeight: '900',
    minHeight: 50,
    minWidth: 120,
    paddingHorizontal: 14,
  },
  pageNumberText: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 4,
    borderColor: '#e5e5e5',
    borderRadius: 18,
    borderWidth: 2,
    color: '#3c3c3c',
    flex: 1,
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 46,
    minHeight: 50,
    textAlign: 'center',
  },
  pageJumpButton: {
    alignItems: 'center',
    backgroundColor: '#58cc02',
    borderBottomColor: '#46a302',
    borderBottomWidth: 5,
    borderRadius: 18,
    flex: 1.2,
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: 10,
  },
  pageJumpButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '900',
  },
  pageStepButton: {
    alignItems: 'center',
    backgroundColor: '#1cb0f6',
    borderBottomColor: '#168ac0',
    borderBottomWidth: 5,
    borderRadius: 18,
    flex: 0.7,
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: 10,
  },
  storyTranslator: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 4,
    borderColor: '#d7f0ce',
    borderRadius: 14,
    borderWidth: 2,
    gap: 8,
    padding: 8,
  },
  translationMiniTitle: {
    color: '#58a700',
    fontSize: 13,
    fontWeight: '900',
  },
  translateScreen: {
    backgroundColor: '#f6fff1',
    flexGrow: 1,
    gap: 14,
    padding: 16,
    paddingBottom: 34,
  },
  translateHero: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 5,
    borderRadius: 22,
    padding: 16,
  },
  translateInput: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#e5e5e5',
    borderBottomWidth: 3,
    borderColor: '#e5e5e5',
    borderRadius: 14,
    borderWidth: 2,
    color: '#3c3c3c',
    fontSize: 15,
    fontWeight: '900',
    minHeight: 44,
    paddingHorizontal: 12,
  },
  translationResult: {
    backgroundColor: '#ddf8d2',
    borderBottomColor: '#58cc02',
    borderBottomWidth: 5,
    borderRadius: 22,
    padding: 18,
  },
  translationResultCompact: {
    backgroundColor: '#ddf8d2',
    borderBottomColor: '#58cc02',
    borderBottomWidth: 3,
    borderRadius: 14,
    padding: 10,
  },
  translationRank: {
    color: '#58a700',
    fontSize: 13,
    fontWeight: '900',
    marginBottom: 6,
  },
  translationWord: {
    color: '#3c3c3c',
    fontSize: 28,
    fontWeight: '900',
  },
  translationMeaning: {
    color: '#58a700',
    fontSize: 22,
    fontWeight: '900',
    marginTop: 8,
  },
  suggestionList: {
    gap: 10,
  },
  suggestionItem: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 4,
    borderRadius: 18,
    padding: 14,
  },
  suggestionWord: {
    color: '#3c3c3c',
    fontSize: 17,
    fontWeight: '900',
  },
  suggestionMeaning: {
    color: '#6b7280',
    fontSize: 14,
    fontWeight: '800',
    marginTop: 4,
  },
  pdfToolbar: {
    alignItems: 'center',
    borderBottomColor: '#e5e7eb',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 12,
  },
  pdfTitle: {
    color: '#111827',
    fontSize: 18,
    fontWeight: '800',
  },
  smallButton: {
    backgroundColor: '#101828',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  smallButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  webLoading: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  testContent: {
    backgroundColor: '#eefbe8',
    gap: 14,
    padding: 20,
    paddingBottom: 34,
  },
  quizBanner: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 5,
    borderRadius: 24,
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'space-between',
    padding: 16,
  },
  quizGem: {
    alignItems: 'center',
    backgroundColor: '#1cb0f6',
    borderBottomColor: '#168ac0',
    borderBottomWidth: 5,
    borderRadius: 28,
    height: 56,
    justifyContent: 'center',
    transform: [{ rotate: '8deg' }],
    width: 56,
  },
  quizGemText: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '900',
  },
  progressTrack: {
    backgroundColor: '#c8edbd',
    borderRadius: 999,
    height: 18,
    overflow: 'hidden',
  },
  progressFill: {
    backgroundColor: '#58cc02',
    borderRadius: 999,
    height: '100%',
  },
  questionCard: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#ffc800',
    borderBottomWidth: 6,
    borderRadius: 24,
    padding: 20,
  },
  questionTitle: {
    color: '#3c3c3c',
    fontSize: 18,
    fontWeight: '900',
    marginBottom: 6,
  },
  questionStep: {
    color: '#58cc02',
    fontSize: 13,
    fontWeight: '900',
    marginBottom: 8,
  },
  questionPrompt: {
    color: '#526070',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  optionRow: {
    gap: 10,
  },
  optionButton: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderBottomColor: '#d7d7d7',
    borderBottomWidth: 4,
    borderColor: '#e5e5e5',
    borderRadius: 18,
    borderWidth: 2,
    minHeight: 52,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  optionButtonSelected: {
    backgroundColor: '#ddf8d2',
    borderBottomColor: '#58cc02',
    borderColor: '#58cc02',
  },
  optionText: {
    color: '#3c3c3c',
    fontSize: 16,
    fontWeight: '900',
    textAlign: 'center',
  },
  optionTextSelected: {
    color: '#58a700',
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#58cc02',
    borderBottomColor: '#46a302',
    borderBottomWidth: 5,
    borderRadius: 18,
    minHeight: 50,
    justifyContent: 'center',
  },
  primaryButtonDisabled: {
    backgroundColor: '#cfd6dd',
    borderBottomColor: '#aab3bd',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '900',
  },
  chatScreen: {
    backgroundColor: '#f5f7fb',
    flex: 1,
  },
  faceGuardCamera: {
    height: 1,
    left: 0,
    opacity: 0,
    position: 'absolute',
    top: 0,
    width: 1,
  },
  guardNotice: {
    alignItems: 'center',
    backgroundColor: '#f5f7fb',
    flex: 1,
    gap: 14,
    justifyContent: 'center',
    padding: 24,
  },
  guardTitle: {
    color: '#111827',
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
  },
  guardText: {
    color: '#526070',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  chatStatus: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderBottomColor: '#e5e7eb',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  statusDot: {
    backgroundColor: '#f2a541',
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  statusDotOnline: {
    backgroundColor: '#1f8a70',
  },
  statusText: {
    color: '#526070',
    fontSize: 13,
    fontWeight: '800',
  },
  locationStatus: {
    color: '#667085',
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'right',
  },
  messageList: {
    flexGrow: 1,
    gap: 10,
    padding: 14,
  },
  messageBubble: {
    borderRadius: 8,
    maxWidth: '82%',
    padding: 12,
  },
  myMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#dff5ee',
  },
  theirMessage: {
    alignSelf: 'flex-start',
    backgroundColor: '#ffffff',
  },
  messageSender: {
    color: '#667085',
    fontSize: 11,
    fontWeight: '800',
    marginBottom: 4,
  },
  messageText: {
    color: '#111827',
    fontSize: 15,
    lineHeight: 21,
  },
  messageImage: {
    backgroundColor: '#eef2f7',
    borderRadius: 8,
    height: 180,
    marginBottom: 8,
    width: 220,
  },
  attachmentMeta: {
    color: '#667085',
    fontSize: 11,
    fontWeight: '800',
    marginBottom: 6,
  },
  locationLink: {
    backgroundColor: '#eef8f5',
    borderColor: '#b7e1d5',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  locationLinkText: {
    color: '#126b56',
    fontSize: 12,
    fontWeight: '900',
  },
  locationScreen: {
    backgroundColor: '#d7e2df',
    flex: 1,
  },
  mapFrame: {
    backgroundColor: '#d7e2df',
    flex: 1,
    overflow: 'hidden',
  },
  mapWebView: {
    flex: 1,
  },
  mapPlaceholder: {
    alignItems: 'center',
    backgroundColor: '#d7e2df',
    flex: 1,
    justifyContent: 'center',
    padding: 28,
  },
  mapPlaceholderTitle: {
    color: '#111827',
    fontSize: 22,
    fontWeight: '900',
    marginBottom: 8,
  },
  mapPlaceholderText: {
    color: '#526070',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  locationLivePill: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    left: 16,
    paddingHorizontal: 12,
    paddingVertical: 9,
    position: 'absolute',
    top: 14,
  },
  locationSheet: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    bottom: 0,
    gap: 8,
    left: 0,
    padding: 18,
    paddingBottom: 22,
    position: 'absolute',
    right: 0,
  },
  locationName: {
    color: '#111827',
    fontSize: 18,
    fontWeight: '900',
  },
  locationMeta: {
    color: '#526070',
    fontSize: 14,
  },
  emptyChat: {
    alignSelf: 'center',
    color: '#667085',
    marginTop: 32,
  },
  composer: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderTopColor: '#e5e7eb',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 10,
    padding: 12,
  },
  messageInput: {
    backgroundColor: '#f5f7fb',
    borderColor: '#d8dee9',
    borderRadius: 8,
    borderWidth: 1,
    color: '#111827',
    flex: 1,
    fontSize: 15,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  photoButton: {
    alignItems: 'center',
    backgroundColor: '#1cb0f6',
    borderBottomColor: '#168ac0',
    borderBottomWidth: 4,
    borderRadius: 12,
    height: 46,
    justifyContent: 'center',
    width: 46,
  },
  photoButtonText: {
    color: '#ffffff',
    fontSize: 26,
    fontWeight: '900',
    lineHeight: 28,
  },
  sendButton: {
    alignItems: 'center',
    backgroundColor: '#101828',
    borderRadius: 8,
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  sendButtonText: {
    color: '#ffffff',
    fontWeight: '900',
  },
});
