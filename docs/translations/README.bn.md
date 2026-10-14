# Home Studio — দ্রুত শুরু

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=bn) · [Languages](README.md)

ব্রাউজারে আপনার বাড়ির নকশা আঁকুন। অ্যাকাউন্টের প্রয়োজন নেই। সম্পাদকের উপরের অংশ থেকে ভাষা বেছে নিন।

1. ঘর, দেয়াল, দরজা ও জানালা যোগ করুন। লাইব্রেরিতে 195টি মডেল আছে। রঙের প্যালেট এবং সমর্থিত বস্তুর জন্য পৃষ্ঠের নকশা বেছে নিন।
2. সম্পাদনাযোগ্য কপি রাখতে JSON রপ্তানি করুন। খসড়া শুধু এই ব্রাউজারেই থাকে। ভাষা বদলালে আপনার নকশা বদলায় না।

সম্পূর্ণ টুলকিট ডাউনলোড করে খুলুন। Python 3.10 বা নতুন সংস্করণ ইনস্টল করুন। টুলকিটের ফোল্ডারে চালান:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

ইংরেজি ইনস্টলেশন গাইডে ব্যাকআপ, Home Assistant OS, কনফিগারেশনের পথ ও পুনরায় চালু করার পদ্ধতি আছে। ব্রাউজার সম্পাদক নিজে Home Assistant-এ সংযুক্ত হয় না বা ডিভাইস নিয়ন্ত্রণ করে না।

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html) · [README](../../README.md) · [i18n](../i18n.md)

আপনার বাড়ির নকশা ও ডিভাইস ID ব্যক্তিগত হতে পারে। প্রকাশ্য উদাহরণে কাল্পনিক বাড়ি ব্যবহার করুন।

এটি অনূদিত সংক্ষিপ্ত নির্দেশিকা। সম্পূর্ণ তথ্যসূত্র ও ছবিসহ গাইড বর্তমানে ইংরেজিতে আছে। অনুবাদ সংশোধনকে স্বাগত জানাই।

MIT · [LICENSE](../../LICENSE)
