# Expo + Node Study Chat

Mobil uygulamada normal ve admin girisi vardir. Normal kullanici PDF okuyabilir, test cozebilir ve ilk uc soruya sirasiyla `A`, `B`, `C` cevaplarini verince admin chat bolumu acilir. Normal kullanici chat ekranindayken telefon ani hareket ederse uygulama test ekranina geri doner.

## Hesaplar

- Normal: `ogrenci` / `123456`
- Admin: `admin` / `admin123`

## Calistirma

Backend:

```bash
npm run start:server
```

Mobil:

```bash
npm run start:mobile
```

Telefon backend'e baglanamazsa `mobile/.env` dosyasinda bilgisayarin LAN IP adresini kullan:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.21:4000
```

