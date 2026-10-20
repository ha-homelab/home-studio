# Home Studio — 빠른 시작

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=ko#native-studio) · [Languages](README.md)

## Home Assistant에서 시작하기

새 집을 설정할 때는 Home Assistant 안의 Home Studio를 사용하세요. 별도의 Python 설치, YAML 또는 액세스 토큰은 필요하지 않습니다.

이미 생성되거나 사용자 지정된 구성 요소를 사용 중이라면 먼저 상세 안내의 **Existing generated homes**를 읽으세요. 자동 변환은 제공되지 않습니다.

1. Home Assistant 2026.10 이상을 사용하고 백업을 만드세요.
2. HACS에서 `https://github.com/ha-homelab/home-studio`를 **Integration** 범주의 사용자 지정 저장소로 추가하세요. **home_floorplan.zip**이 포함된 Home Studio 안정 버전을 설치하고 Home Assistant를 다시 시작하세요.
3. **Settings → Devices & services → Add integration → Home Studio**를 여세요.
4. 관리자 계정으로 사이드바의 **Home Studio**를 여세요. 방을 그리고 물건을 실제 HA 기기에 연결하세요.
5. **Save draft**, 이어서 **Publish family view**를 누르세요. **3D Home**을 열고 기기를 제어하기 전에 **Dry run**으로 연결을 확인하세요.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## 선택 사항: HA를 설정하는 동안 그리기

HA를 준비하는 동안 별도의 브라우저 편집기를 사용할 수 있습니다. 이 편집기는 HA에 실시간으로 연결되지 않습니다. JSON을 내보낸 다음 HA 안의 Home Studio에서 **Open JSON**으로 열고 기기를 확인한 후 저장하고 게시하세요.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=ko)

브라우저에서 집의 평면도를 그려 보세요. 계정은 필요하지 않습니다. 편집기 상단에서 언어를 선택하세요.

1. 방, 벽, 문, 창문을 추가하세요. 라이브러리에는 모델 206개가 있습니다. 색상 팔레트를 선택하고, 지원되는 물건에는 표면 무늬도 설정할 수 있습니다.
2. 편집 가능한 사본을 보관하려면 JSON을 내보내세요. 초안은 이 브라우저에만 저장됩니다. 언어를 바꿔도 평면도는 변경되지 않습니다.

### 선택 사항: 휴대용 도구 모음과 Python 컴파일러

이 과정은 별도 빌드와 기존 생성형 설치를 위한 것입니다. 새 네이티브 설치에서는 건너뛰세요.

전체 도구 모음을 다운로드해 압축을 풀고 Python 3.10 이상을 설치하세요. 도구 폴더에서 다음을 실행하세요:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

영문 설치 안내에는 백업, Home Assistant OS, 설정 경로, 재시작 방법이 설명되어 있습니다. 브라우저 편집기 자체는 Home Assistant에 연결하거나 기기를 제어하지 않습니다.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=ko) · [README](../../README.md) · [i18n](../i18n.md)

집의 평면도와 기기 엔터티 ID는 개인 정보일 수 있습니다. 공개 예시에는 가상의 집을 사용하세요.

이 문서는 번역된 빠른 시작 안내입니다. 전체 참고 문서와 그림 안내는 현재 영어로 제공됩니다. 번역 수정에 참여해 주세요.

## 명령 없이 버튼 시험하기

설치된 Home Assistant 평면도에서 Dry run을 켜면 명령을 보내지 않고 버튼을 시험할 수 있습니다. 스위치, TV 전원, 커튼 및 잠금 제어가 포함된 기본 대화상자가 차단되며 실제 상태는 계속 표시됩니다. 이 브라우저에서 보호하려면 평면도 URL에 ?dry_run=1을 붙여 북마크하세요. 배치 변경은 계속 저장할 수 있습니다.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
