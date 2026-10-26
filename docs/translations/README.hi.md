# Home Studio — त्वरित शुरुआत

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=hi#native-studio) · [Languages](README.md)

## Home Assistant में शुरू करें

नए घर के लिए Home Assistant के अंदर Home Studio का उपयोग करें। अलग से Python इंस्टॉल करने, YAML लिखने या एक्सेस टोकन बनाने की ज़रूरत नहीं है।

यदि पहले से जनरेट किया गया या कस्टमाइज़ किया गया घटक इस्तेमाल कर रहे हैं, तो पहले विस्तृत गाइड का **Existing generated homes** भाग पढ़ें; स्वचालित रूपांतरण नहीं होता।

1. Home Assistant 2026.10 या नया संस्करण उपयोग करें और बैकअप बनाएं।
2. HACS में `https://github.com/ha-homelab/home-studio` को **Integration** श्रेणी में कस्टम रिपॉज़िटरी के रूप में जोड़ें। **home_floorplan.zip** वाला Home Studio का स्थिर संस्करण इंस्टॉल करें और Home Assistant को दोबारा शुरू करें।
3. **Settings → Devices & services → Add integration → Home Studio** खोलें।
4. व्यवस्थापक खाते से साइडबार में **Home Studio** खोलें। एक कमरा बनाएं और वस्तुओं को वास्तविक HA उपकरणों से जोड़ें।
5. **Save draft** और फिर **Publish family view** दबाएं। **3D Home** खोलें और उपकरणों को नियंत्रित करने से पहले **Dry run** में जुड़ाव जांचें।

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## वैकल्पिक: HA सेट अप करते समय नक्शा बनाना

HA तैयार करते समय अलग ब्राउज़र संपादक इस्तेमाल कर सकते हैं। इसका HA से लाइव कनेक्शन नहीं है। JSON एक्सपोर्ट करें, फिर HA के अंदर Home Studio में **Open JSON** से खोलें, उपकरण जांचें, सेव करें और प्रकाशित करें।

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=hi)

ब्राउज़र में अपने घर का नक्शा बनाएँ। खाते की ज़रूरत नहीं है। संपादक के ऊपर अपनी भाषा चुनें।

1. कमरे, दीवारें, दरवाज़े और खिड़कियाँ जोड़ें। लाइब्रेरी में 211 मॉडल हैं। रंग-पैलेट चुनें और समर्थित वस्तुओं के लिए सतह का पैटर्न भी चुनें।
2. संपादन योग्य प्रति रखने के लिए JSON निर्यात करें। ड्राफ़्ट केवल इसी ब्राउज़र में रहते हैं। भाषा बदलने से आपका नक्शा नहीं बदलता।

### वैकल्पिक: पोर्टेबल टूलकिट और Python कंपाइलर

यह तरीका अलग बिल्ड और पहले से जनरेट किए गए इंस्टॉलेशन के लिए है; नए नेटिव इंस्टॉलेशन में इसे छोड़ दें।

पूरा टूलकिट डाउनलोड करके निकालें। Python 3.10 या नया संस्करण स्थापित करें। टूलकिट के फ़ोल्डर में यह चलाएँ:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

अंग्रेज़ी इंस्टॉलेशन गाइड में बैकअप, Home Assistant OS, कॉन्फ़िगरेशन का पथ और रीस्टार्ट समझाए गए हैं। ब्राउज़र संपादक स्वयं Home Assistant से नहीं जुड़ता और उपकरणों को नियंत्रित नहीं करता।

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=hi) · [README](../../README.md) · [i18n](../i18n.md)

आपके घर का नक्शा और उपकरणों के ID निजी हो सकते हैं। सार्वजनिक उदाहरणों के लिए काल्पनिक घर इस्तेमाल करें।

यह अनुवादित त्वरित मार्गदर्शिका है। पूरा संदर्भ और सचित्र गाइड अभी अंग्रेज़ी में हैं। अनुवाद सुधारों का स्वागत है।

## बिना आदेश भेजे बटन जाँचना

इंस्टॉल किए गए Home Assistant नक्शे में बिना आदेश भेजे बटन जाँचने के लिए Dry run चालू करें। स्विच, टीवी की बिजली, पर्दे और ताले के नियंत्रण वाले मूल संवाद रोके जाते हैं; दिखाई गई स्थितियाँ वास्तविक रहती हैं। इस ब्राउज़र में मोड बनाए रखने के लिए नक्शे के पते में ?dry_run=1 जोड़कर बुकमार्क करें। लेआउट में बदलाव अब भी सहेजे जा सकते हैं।

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
