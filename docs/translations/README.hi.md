# Home Studio — त्वरित शुरुआत

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=hi) · [Languages](README.md)

ब्राउज़र में अपने घर का नक्शा बनाएँ। खाते की ज़रूरत नहीं है। संपादक के ऊपर अपनी भाषा चुनें।

1. कमरे, दीवारें, दरवाज़े और खिड़कियाँ जोड़ें। लाइब्रेरी में 195 मॉडल हैं। रंग-पैलेट चुनें और समर्थित वस्तुओं के लिए सतह का पैटर्न भी चुनें।
2. संपादन योग्य प्रति रखने के लिए JSON निर्यात करें। ड्राफ़्ट केवल इसी ब्राउज़र में रहते हैं। भाषा बदलने से आपका नक्शा नहीं बदलता।

पूरा टूलकिट डाउनलोड करके निकालें। Python 3.10 या नया संस्करण स्थापित करें। टूलकिट के फ़ोल्डर में यह चलाएँ:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

अंग्रेज़ी इंस्टॉलेशन गाइड में बैकअप, Home Assistant OS, कॉन्फ़िगरेशन का पथ और रीस्टार्ट समझाए गए हैं। ब्राउज़र संपादक स्वयं Home Assistant से नहीं जुड़ता और उपकरणों को नियंत्रित नहीं करता।

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html) · [README](../../README.md) · [i18n](../i18n.md)

आपके घर का नक्शा और उपकरणों के ID निजी हो सकते हैं। सार्वजनिक उदाहरणों के लिए काल्पनिक घर इस्तेमाल करें।

यह अनुवादित त्वरित मार्गदर्शिका है। पूरा संदर्भ और सचित्र गाइड अभी अंग्रेज़ी में हैं। अनुवाद सुधारों का स्वागत है।

MIT · [LICENSE](../../LICENSE)
