# Home Studio — 빠른 시작

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=ko) · [Languages](README.md)

브라우저에서 집의 평면도를 그려 보세요. 계정은 필요하지 않습니다. 편집기 상단에서 언어를 선택하세요.

1. 방, 벽, 문, 창문을 추가하세요. 라이브러리에는 모델 195개가 있습니다. 색상 팔레트를 선택하고, 지원되는 물건에는 표면 무늬도 설정할 수 있습니다.
2. 편집 가능한 사본을 보관하려면 JSON을 내보내세요. 초안은 이 브라우저에만 저장됩니다. 언어를 바꿔도 평면도는 변경되지 않습니다.

전체 도구 모음을 다운로드해 압축을 풀고 Python 3.10 이상을 설치하세요. 도구 폴더에서 다음을 실행하세요:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

영문 설치 안내에는 백업, Home Assistant OS, 설정 경로, 재시작 방법이 설명되어 있습니다. 브라우저 편집기 자체는 Home Assistant에 연결하거나 기기를 제어하지 않습니다.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html) · [README](../../README.md) · [i18n](../i18n.md)

집의 평면도와 기기 엔터티 ID는 개인 정보일 수 있습니다. 공개 예시에는 가상의 집을 사용하세요.

이 문서는 번역된 빠른 시작 안내입니다. 전체 참고 문서와 그림 안내는 현재 영어로 제공됩니다. 번역 수정에 참여해 주세요.

MIT · [LICENSE](../../LICENSE)
