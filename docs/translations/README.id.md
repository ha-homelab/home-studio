# Home Studio — Mulai cepat

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=id#native-studio) · [Languages](README.md)

## Mulai di Home Assistant

Untuk rumah baru, gunakan Home Studio di dalam Home Assistant. Tidak perlu memasang Python secara terpisah, menulis YAML, atau membuat token akses.

Jika sudah memakai komponen hasil pembuatan atau yang telah disesuaikan, baca dahulu **Existing generated homes** pada panduan lengkap: tidak ada konversi otomatis.

1. Gunakan Home Assistant 2026.10 atau yang lebih baru dan buat cadangan.
2. Di HACS, tambahkan `https://github.com/ha-homelab/home-studio` sebagai repositori kustom dengan kategori **Integration**. Pasang rilis stabil Home Studio yang menyertakan **home_floorplan.zip**, lalu mulai ulang Home Assistant.
3. Buka **Settings → Devices & services → Add integration → Home Studio**.
4. Dengan akun administrator, buka **Home Studio** di bilah samping. Gambar ruangan dan hubungkan objek dengan perangkat HA yang sebenarnya.
5. Klik **Save draft**, lalu **Publish family view**. Buka **3D Home** dan periksa hubungan perangkat dengan **Dry run** sebelum mengendalikan perangkat.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## Opsional: menggambar sambil menyiapkan HA

Editor browser terpisah dapat dipakai saat menyiapkan HA. Editor ini tidak memiliki koneksi langsung ke HA. Ekspor JSON, lalu buka dengan **Open JSON** di Home Studio dalam HA, periksa perangkat, simpan, dan publikasikan.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=id)

Gambar rumah Anda di browser. Tidak perlu akun. Pilih bahasa di bagian atas editor.

1. Tambahkan ruangan, dinding, pintu, dan jendela. Pustaka berisi 206 model. Pilih palet warna dan, untuk objek yang mendukungnya, pola permukaan.
2. Ekspor JSON untuk menyimpan salinan yang bisa diedit. Draf hanya tersimpan di browser ini. Mengganti bahasa tidak mengubah denah Anda.

### Opsional: perangkat alat portabel dan kompiler Python

Jalur ini untuk pembuatan terpisah dan instalasi lama yang dihasilkan; lewati untuk instalasi native baru.

Unduh dan ekstrak paket alat lengkap. Pasang Python 3.10 atau lebih baru. Jalankan perintah berikut di folder paket alat:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

Panduan instalasi berbahasa Inggris menjelaskan cadangan, Home Assistant OS, lokasi konfigurasi, dan mulai ulang. Editor browser sendiri tidak terhubung ke Home Assistant atau mengendalikan perangkat.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=id) · [README](../../README.md) · [i18n](../i18n.md)

Denah rumah dan ID entitas perangkat mungkin bersifat pribadi. Gunakan rumah fiktif untuk contoh publik.

Ini adalah panduan singkat terjemahan. Referensi lengkap dan panduan bergambar saat ini tersedia dalam bahasa Inggris. Koreksi terjemahan sangat diterima.

## Mencoba tombol tanpa perintah

Pada denah Home Assistant yang terpasang, aktifkan Dry run untuk mencoba tombol tanpa mengirim perintah. Sakelar, daya TV, tirai, dan dialog bawaan berisi kontrol kunci diblokir; status tetap nyata. Simpan alamat denah dengan ?dry_run=1 sebagai markah di peramban ini. Perubahan tata letak tetap dapat disimpan.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
