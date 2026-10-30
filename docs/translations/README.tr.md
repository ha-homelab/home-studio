# Home Studio — Hızlı başlangıç

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=tr#native-studio) · [Languages](README.md)

## Home Assistant içinde başlayın

Yeni bir ev için Home Studio’yu Home Assistant içinde kullanın. Ayrı bir Python kurulumu, YAML veya erişim belirteci gerekmez.

Önceden oluşturulmuş veya özelleştirilmiş bir bileşen kullanıyorsanız önce ayrıntılı kılavuzdaki **Existing generated homes** bölümünü okuyun; otomatik dönüştürme yapılmaz.

1. Home Assistant 2026.10 veya daha yeni bir sürüm kullanın ve yedek alın.
2. HACS içinde `https://github.com/ha-homelab/home-studio` adresini **Integration** kategorisinde özel depo olarak ekleyin. **home_floorplan.zip** içeren kararlı Home Studio sürümünü kurun ve Home Assistant’ı yeniden başlatın.
3. **Settings → Devices & services → Add integration → Home Studio** yolunu açın.
4. Yönetici hesabıyla kenar çubuğundaki **Home Studio**’yu açın. Bir oda çizin ve nesneleri gerçek HA cihazlarına bağlayın.
5. **Save draft**, ardından **Publish family view** düğmesine basın. **3D Home**’u açın ve cihazları kontrol etmeden önce bağlantıları **Dry run** ile denetleyin.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## İsteğe bağlı: HA kurulurken çizim yapma

HA’yı hazırlarken ayrı tarayıcı düzenleyicisini kullanabilirsiniz. Bu düzenleyicinin HA ile canlı bağlantısı yoktur. JSON dışa aktarın, ardından HA içindeki Home Studio’da **Open JSON** ile açın, cihazları denetleyin, kaydedin ve yayımlayın.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=tr)

Evinizi tarayıcıda çizin. Hesap gerekmez. Dili düzenleyicinin üst kısmından seçin.

1. Odalar, duvarlar, kapılar ve pencereler ekleyin. Kütüphanede 211 model bulunur. Bir renk paleti ve desteklenen nesneler için yüzey deseni seçin.
2. Düzenlenebilir bir kopya saklamak için JSON dışa aktarın. Taslaklar yalnızca bu tarayıcıda kalır. Dil değiştirmek planınızı değiştirmez.

### İsteğe bağlı: Taşınabilir araçlar ve Python derleyicisi

Bu yol, ayrı derlemeler ve daha önce oluşturulmuş kurulumlar içindir; yeni bir yerel kurulumda bu adımları atlayın.

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
