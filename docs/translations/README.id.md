# Home Studio — Mulai cepat

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=id) · [Languages](README.md)

Gambar rumah Anda di browser. Tidak perlu akun. Pilih bahasa di bagian atas editor.

1. Tambahkan ruangan, dinding, pintu, dan jendela. Pustaka berisi 195 model. Pilih palet warna dan, untuk objek yang mendukungnya, pola permukaan.
2. Ekspor JSON untuk menyimpan salinan yang bisa diedit. Draf hanya tersimpan di browser ini. Mengganti bahasa tidak mengubah denah Anda.

Unduh dan ekstrak paket alat lengkap. Pasang Python 3.10 atau lebih baru. Jalankan perintah berikut di folder paket alat:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

Panduan instalasi berbahasa Inggris menjelaskan cadangan, Home Assistant OS, lokasi konfigurasi, dan mulai ulang. Editor browser sendiri tidak terhubung ke Home Assistant atau mengendalikan perangkat.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=id) · [README](../../README.md) · [i18n](../i18n.md)

Denah rumah dan ID entitas perangkat mungkin bersifat pribadi. Gunakan rumah fiktif untuk contoh publik.

Ini adalah panduan singkat terjemahan. Referensi lengkap dan panduan bergambar saat ini tersedia dalam bahasa Inggris. Koreksi terjemahan sangat diterima.

MIT · [LICENSE](../../LICENSE)
