# BeriaApp

Expo React Native mobil uygulamasi ve Node.js/Express backendinden olusan Ispanyolca calisma demosu.

## Ozellikler

- Berivan icin oyunlastirilmis ana menu
- PDF okuma ve hikaye okuma ekranlari
- Hikaye ekraninda offline Ispanyolca-Turkce kelime cevirisi
- 100 soruluk test akisi
- Ilk 3 soru dogru cevaplaninca chat ekranina gecis
- Admin chat paneli
- Admin icin kullanici aktif/arka plan/son gorulme bilgisi
- Canli konum gosterimi
- Mesaj bildirimi: kullanici uygulamada degilse gider, 30 dakika boyunca tekrar gitmez
- Mesajlar icin PostgreSQL kalici kayit destegi
- Ayarlardan yuz tarama ac/kapat; secim cihazda kalici saklanir
- Expo Development Build ile Vision Camera yuz varligi kontrolu
- Web'de Vision Camera devre disi kalir, uygulama kamera hatasi vermeden calisir

## Klasor Yapisi

```text
.
+-- server/              # Express + Socket.IO backend
+-- mobile/              # Expo React Native uygulamasi
+-- render.yaml          # Render web service ayari
+-- package.json         # Backend calistirma ve bagimliliklari
+-- README.md
```

## Hesaplar

```text
Normal kullanici: ogrenci / 123456
Admin: admin / admin123
```

Mobil giris ekraninda normal kullanici ana akistir. Admin girisi sag ustteki kucuk `Admin girisi` butonundan acilir.

## Backend

Backend `server/index.js` icindedir.

Kullanilan teknolojiler:

- Express
- Socket.IO
- PostgreSQL icin `pg`
- Expo Push Notification API

Backend baslatma:

```bash
npm install
npm start
```

Local gelistirme icin:

```bash
npm run start:server
```

Saglik kontrolu:

```text
GET /health
```

Canli Render backend URL:

```text
https://beriaapp.onrender.com
```

## Kalici Mesajlar

Backend `DATABASE_URL` environment variable bulursa mesajlari PostgreSQL'e yazar.

Render Postgres olusturduktan sonra backend web service icin Environment bolumune ekle:

```text
DATABASE_URL=Internal Database URL
```

Sonra Render'da:

```text
Manual Deploy > Deploy latest commit
```

Database bagli degilse backend yine calisir, ama mesajlar sadece RAM'de gecici tutulur.

## Mobil Uygulama

Mobil klasore gir:

```bash
cd mobile
npm install
```

`.env` dosyasi:

```env
EXPO_PUBLIC_API_URL=https://beriaapp.onrender.com
```

Development client ile baslatma:

```bash
npx expo start --dev-client --lan -c
```

Web icin:

```bash
npx expo start --web -c
```

## iOS Development Build

Bu uygulama Expo Go ile tam calismaz. Vision Camera ve native moduller icin Expo Development Build gerekir.

```bash
cd mobile
eas build --profile development --platform ios
```

Build telefona kurulduktan sonra:

```bash
npx expo start --dev-client --lan -c
```

## Bildirim Mantigi

Calisma saati hatirlaticisi kapali.

Mesaj bildirimi su sekilde calisir:

- Alici uygulamada aktifse bildirim gitmez.
- Alici uygulamada degilse ilk mesaj icin bildirim gider.
- Bildirimden sonra ayni aliciya 30 dakika boyunca yeni mesaj bildirimi gitmez.
- 30 dakika dolduktan sonra alici hala uygulamada degilse sonraki mesaj icin tekrar bildirim gider.

## Render Deploy

Backend icin Render ayarlari `render.yaml` icindedir.

Render Web Service ayarlari:

```text
Build Command: npm install
Start Command: npm start
Health Check Path: /health
```

Postgres baglamak icin backend service Environment bolumune `DATABASE_URL` eklenmelidir.

## Notlar

- Oturumlar, kullanici durumlari, konum ve push token bilgileri su an RAM'de tutulur.
- Mesajlar Postgres baglaninca kalici olur.
- Render Free plan uykuya gecebilir; ilk istek gec gelebilir.
