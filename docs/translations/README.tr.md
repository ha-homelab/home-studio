# Home Studio — Hızlı başlangıç

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=tr) · [Languages](README.md)

Evinizi tarayıcıda çizin. Hesap gerekmez. Dili düzenleyicinin üst kısmından seçin.

1. Odalar, duvarlar, kapılar ve pencereler ekleyin. Kütüphanede 195 model bulunur. Bir renk paleti ve desteklenen nesneler için yüzey deseni seçin.
2. Düzenlenebilir bir kopya saklamak için JSON dışa aktarın. Taslaklar yalnızca bu tarayıcıda kalır. Dil değiştirmek planınızı değiştirmez.

Araçların tamamını indirip arşivi açın. Python 3.10 veya üzerini kurun. Araç klasöründe şu komutu çalıştırın:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

İngilizce kurulum kılavuzu yedeklemeyi, Home Assistant OS’yi, yapılandırma yolunu ve yeniden başlatmayı açıklar. Tarayıcı düzenleyicisi doğrudan Home Assistant’a bağlanmaz ve cihazları kontrol etmez.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=tr) · [README](../../README.md) · [i18n](../i18n.md)

Ev planınız ve cihaz kimlikleri özel olabilir. Herkese açık örneklerde kurgusal bir ev kullanın.

Bu, çevrilmiş bir hızlı başlangıç kılavuzudur. Tam başvuru belgeleri ve resimli kılavuz şu anda İngilizcedir. Çeviri düzeltmelerine katkıda bulunabilirsiniz.

MIT · [LICENSE](../../LICENSE)
