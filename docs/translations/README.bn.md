# Home Studio — দ্রুত শুরু

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=bn#native-studio) · [Languages](README.md)

## Home Assistant-এর ভিতরে শুরু করুন

নতুন বাড়ির জন্য Home Assistant-এর ভিতরে Home Studio ব্যবহার করুন। আলাদাভাবে Python ইনস্টল, YAML লেখা বা অ্যাক্সেস টোকেন তৈরি করার প্রয়োজন নেই।

আগে থেকে তৈরি বা কাস্টমাইজ করা কম্পোনেন্ট থাকলে প্রথমে বিস্তারিত গাইডের **Existing generated homes** পড়ুন; স্বয়ংক্রিয় রূপান্তর হয় না।

1. Home Assistant 2026.10 বা নতুন সংস্করণ ব্যবহার করুন এবং ব্যাকআপ নিন।
2. HACS-এ `https://github.com/ha-homelab/home-studio`-কে **Integration** বিভাগের কাস্টম রিপোজিটরি হিসেবে যোগ করুন। **home_floorplan.zip**-সহ Home Studio-এর স্থিতিশীল সংস্করণ ইনস্টল করুন এবং Home Assistant পুনরায় চালু করুন।
3. **Settings → Devices & services → Add integration → Home Studio** খুলুন।
4. প্রশাসক অ্যাকাউন্ট দিয়ে পাশের বারে **Home Studio** খুলুন। একটি ঘর আঁকুন এবং বস্তুগুলোকে প্রকৃত HA ডিভাইসের সঙ্গে যুক্ত করুন।
5. **Save draft**, তারপর **Publish family view** চাপুন। **3D Home** খুলে ডিভাইস নিয়ন্ত্রণ করার আগে **Dry run** দিয়ে সংযোগগুলো পরীক্ষা করুন।

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## ঐচ্ছিক: HA সেট আপ করার সময় নকশা আঁকা

HA প্রস্তুত করার সময় আলাদা ব্রাউজার সম্পাদক ব্যবহার করতে পারেন। এর সঙ্গে HA-এর লাইভ সংযোগ নেই। JSON রপ্তানি করুন, তারপর HA-এর ভিতরে Home Studio-তে **Open JSON** দিয়ে খুলুন, ডিভাইস পরীক্ষা করুন, সংরক্ষণ ও প্রকাশ করুন।

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=bn)

ব্রাউজারে আপনার বাড়ির নকশা আঁকুন। অ্যাকাউন্টের প্রয়োজন নেই। সম্পাদকের উপরের অংশ থেকে ভাষা বেছে নিন।

1. ঘর, দেয়াল, দরজা ও জানালা যোগ করুন। লাইব্রেরিতে 206টি মডেল আছে। রঙের প্যালেট এবং সমর্থিত বস্তুর জন্য পৃষ্ঠের নকশা বেছে নিন।
2. সম্পাদনাযোগ্য কপি রাখতে JSON রপ্তানি করুন। খসড়া শুধু এই ব্রাউজারেই থাকে। ভাষা বদলালে আপনার নকশা বদলায় না।

### ঐচ্ছিক: বহনযোগ্য টুলকিট ও Python কম্পাইলার

এই পদ্ধতি আলাদা বিল্ড ও আগে তৈরি করা ইনস্টলেশনের জন্য; নতুন নেটিভ ইনস্টলেশনের ক্ষেত্রে এটি এড়িয়ে যান।

সম্পূর্ণ টুলকিট ডাউনলোড করে খুলুন। Python 3.10 বা নতুন সংস্করণ ইনস্টল করুন। টুলকিটের ফোল্ডারে চালান:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

ইংরেজি ইনস্টলেশন গাইডে ব্যাকআপ, Home Assistant OS, কনফিগারেশনের পথ ও পুনরায় চালু করার পদ্ধতি আছে। ব্রাউজার সম্পাদক নিজে Home Assistant-এ সংযুক্ত হয় না বা ডিভাইস নিয়ন্ত্রণ করে না।

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=bn) · [README](../../README.md) · [i18n](../i18n.md)

আপনার বাড়ির নকশা ও ডিভাইস ID ব্যক্তিগত হতে পারে। প্রকাশ্য উদাহরণে কাল্পনিক বাড়ি ব্যবহার করুন।

এটি অনূদিত সংক্ষিপ্ত নির্দেশিকা। সম্পূর্ণ তথ্যসূত্র ও ছবিসহ গাইড বর্তমানে ইংরেজিতে আছে। অনুবাদ সংশোধনকে স্বাগত জানাই।

## নির্দেশ ছাড়া বোতাম পরীক্ষা

ইনস্টল করা Home Assistant নকশায় নির্দেশ না পাঠিয়ে বোতাম পরীক্ষার জন্য Dry run চালু করুন। সুইচ, টিভির বিদ্যুৎ, পর্দা এবং তালার নিয়ন্ত্রণ থাকা মূল ডায়ালগ বন্ধ থাকে; দেখানো অবস্থা প্রকৃত থাকে। এই ব্রাউজারে মোড রাখতে নকশার ঠিকানায় ?dry_run=1 যোগ করে বুকমার্ক করুন। বিন্যাসের পরিবর্তন এখনও সংরক্ষণ করা যায়।

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
