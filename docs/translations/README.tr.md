# Home Studio — Hızlı başlangıç

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=tr) · [Languages](README.md)

Evinizi tarayıcıda çizin. Hesap gerekmez. Dili düzenleyicinin üst kısmından seçin.

1. Odalar, duvarlar, kapılar ve pencereler ekleyin. Kütüphanede 195 model bulunur. Bir renk paleti ve desteklenen nesneler için yüzey deseni seçin.
2. Düzenlenebilir bir kopya saklamak için JSON dışa aktarın. Taslaklar yalnızca bu tarayıcıda kalır. Dil değiştirmek planınızı değiştirmez.

Araçların tamamını indirip arşivi açın. Python 3.10 veya üzerini kurun. Araç klasöründe şu komutu çalıştırın:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

İngilizce kurulum kılavuzu yedeklemeyi, Home Assistant OS’yi, yapılandırma yolunu ve yeniden başlatmayı açıklar. Tarayıcı düzenleyicisi doğrudan Home Assistant’a bağlanmaz ve cihazları kontrol etmez.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=tr) · [README](../../README.md) · [i18n](../i18n.md)

Ev planınız ve cihaz kimlikleri özel olabilir. Herkese açık örneklerde kurgusal bir ev kullanın.

Bu, çevrilmiş bir hızlı başlangıç kılavuzudur. Tam başvuru belgeleri ve resimli kılavuz şu anda İngilizcedir. Çeviri düzeltmelerine katkıda bulunabilirsiniz.

## Komut göndermeden düğmeleri deneme

Kurulu Home Assistant planında düğmeleri komut göndermeden denemek için Dry run modunu açın. Anahtarlar, TV gücü, perdeler ve kilit kontrolleri içeren yerel pencereler engellenir; durumlar gerçek kalır. Plan adresini ?dry_run=1 ile bu tarayıcıya yer imi olarak kaydedin. Yerleşim değişiklikleri yine kaydedilebilir.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
