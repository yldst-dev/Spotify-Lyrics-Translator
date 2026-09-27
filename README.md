# Spotify Lyrics Translator

Spotify 데스크톱 앱의 가사 화면(노래방 버튼)에서 원문 줄마다 LLM 번역을 한 줄씩 붙여 보여 줍니다. Spicetify 없이 동작하고, Spotify가 업데이트되어 패치가 풀리면 알아서 다시 적용합니다.

## 동작 방식

```
Spotify 앱 (xpui.spa에 스크립트 한 줄 주입)
  ├─ Spotify가 받아 오는 color-lyrics 응답에서 곡 전체 가사를 읽음
  ├─ 화면에 떠 있는 가사로 지금 곡을 알아냄
  ├─ 같은 곡이 0.4초 동안 그대로면 번역 요청, 곡이 바뀌면 요청 취소
  └─ data-testid="lyrics-line" 줄마다 번역 줄을 붙임
          │ http://127.0.0.1:47831/translate
로컬 데몬 (Bun, launchd로 상시 실행)
  ├─ 번역기 호출 (codex-gateway, OpenRouter, Claude 중 선택)
  ├─ 곡 단위 번역 캐시 (SQLite)
  ├─ 30초마다 xpui.spa를 확인하고 패치가 풀렸으면 다시 적용
  └─ Spotify를 끄거나 켤 때 GitHub 새 릴리스를 확인하고 자동 업데이트
```

- 번역 줄은 Spotify 가사와 같은 색과 서체를 쓰고, 크기만 작고 조금 흐리게 보입니다. 지금 부르는 줄 강조도 원문과 함께 바뀝니다.
- 일본어, 중국어, 영어, 한국어가 섞인 가사도 줄마다 끝까지 번역합니다. 한 줄 안에 여러 언어가 섞여 있으면 그 줄 전체를 한국어로 옮깁니다.
- 전부 한국어인 줄, 빈 줄, `♪` 같은 기호 줄, "oh", "la la" 같은 추임새는 번역하지 않습니다.
- 번역을 받은 뒤 다른 언어가 그대로 남은 줄이 있으면, 그 줄만 곡 전체를 참고해 한 번 더 번역합니다.
- 한 번 번역한 곡은 캐시에서 바로 나옵니다.

## 요구 사항

| 항목 | 확인한 버전 |
|---|---|
| macOS | 27.0 |
| Spotify 데스크톱 | 1.3.0.277 |
| Bun | 1.3.5 |
| `zip`, `unzip` | macOS 기본 포함 |

패처가 `/Applications/Spotify.app` 안의 파일을 고치기 때문에, 명령을 실행하는 터미널 앱에 macOS의 "앱 관리" 권한이 있어야 합니다. 시스템 설정의 개인정보 보호 및 보안에서 켤 수 있습니다.

## 설치

1. 설정 파일을 만듭니다.

   ```bash
   cp .env.example .env
   chmod 600 .env
   ```

2. `.env`에 쓸 번역기와 키를 넣습니다. 자세한 값은 아래 [번역기 설정](#번역기-설정)을 봅니다.

3. 데몬을 launchd에 등록합니다. 등록하면 바로 실행되고, 로그인할 때마다 자동으로 켜집니다. 처음 실행될 때 원본 `xpui.spa`를 백업하고 확장을 주입합니다.

   ```bash
   bun run install-agent
   ```

4. Spotify를 완전히 종료했다가 다시 켭니다. 주입한 스크립트는 Spotify가 시작될 때 읽힙니다.

5. 가사가 있는 곡을 틀고 가사 화면(오른쪽 패널 또는 전체 가사 화면)을 엽니다. 처음 보는 곡은 10초에서 25초쯤 뒤에 번역이 붙습니다.

## 사용법

- **번역 켜고 끄기**: Spotify 창에서 `Alt+T`(`Option+T`)를 누릅니다. 설정은 기억됩니다.
- **번역 시점**: 가사 화면이 열려 있을 때만 지금 곡을 번역합니다. 가사 화면을 닫아 두면 요청하지 않습니다.
- **곡 넘기기**: 빠르게 여러 곡을 넘기면 멈춘 곡 하나만 번역합니다. 넘어간 곡의 진행 중 요청은 번역기 호출까지 취소됩니다.
- **목표 언어**: 한국어로 고정되어 있습니다. 바꾸려면 `extension/lyrics-translator.js`의 `LANG`을 고칩니다. 쓸 수 있는 값은 `ko`, `en`, `ja`, `zh-CN`, `zh-TW`, `es`, `fr`, `de`입니다.

## 번역기 설정

`.env`의 `SLT_TRANSLATOR`로 번역기를 고릅니다. 값을 바꾼 뒤에는 `bun run restart-agent`로 데몬을 다시 시작합니다. 캐시는 번역기, 모델, effort마다 따로 저장되므로 섞이지 않습니다.

### 공통

| 변수 | 기본값 | 설명 |
|---|---|---|
| `SLT_TRANSLATOR` | `codex` | `codex`, `openrouter`, `claude`, `mock` 중 하나 |
| `SLT_EFFORT` | `medium` | 추론 강도. 낮을수록 빠르고 저렴합니다 |
| `SLT_AUTO_UPDATE` | `1` | `0`이면 자동 업데이트를 끕니다 |

### codex-gateway (`SLT_TRANSLATOR=codex`)

OpenAI Responses API 형식의 codex-gateway로 요청합니다. 게이트웨이 규칙에 맞춰 `stream: true`, `store: false`로 보내고, 스트림으로 온 텍스트 조각을 이어 붙여 씁니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `CODEX_GATEWAY_BASE_URL` | `http://192.168.0.9:8080/v1` | 게이트웨이 주소 |
| `CODEX_GATEWAY_API_KEY` | 없음 | 관리 화면에서 만든 `cg_` 키. 이 용도 전용으로 따로 만드는 것을 권합니다 |
| `CODEX_MODEL` | `gpt-6-astra` | 게이트웨이 `/v1/models`에 있는 모델 |
| `CODEX_SERVICE_TIER` | `priority` | `priority`면 fast 모드, `default`면 표준 속도 |

fast 모드는 기본으로 켜져 있습니다. 요청에 `"service_tier": "priority"`를 넣어 Codex CLI의 `/fast on`과 같게 처리합니다. 글자가 나오는 속도가 빨라지는 대신 ChatGPT 요금제의 Codex 사용량을 표준의 2.5배 씁니다. 모델이 fast 모드를 지원하지 않으면 오류 없이 표준 속도로 처리됩니다. 사용량을 아끼려면 `CODEX_SERVICE_TIER=default`로 둡니다. 속도만 달라지고 번역 결과는 같아서, 값을 바꿔도 이미 캐시된 번역을 그대로 씁니다.

### OpenRouter (`SLT_TRANSLATOR=openrouter`)

`/chat/completions`에 JSON 스키마 형식(`strict: true`)을 붙여 요청합니다. 이 형식을 지원하는 모델에만 보내도록 `provider.require_parameters: true`를 넣습니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `OPENROUTER_API_KEY` | 없음 | OpenRouter 키 |
| `OPENROUTER_MODEL` | `openai/gpt-6-luna` | 구조화 출력(`structured_outputs`)을 지원하는 모델 |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | 바꿀 일이 거의 없습니다 |

### Claude (`SLT_TRANSLATOR=claude`)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 없음 | Anthropic API 키 |
| `SLT_MODEL` | `claude-opus-5` | 모델 ID |

### 가짜 번역기 (`SLT_TRANSLATOR=mock`)

키 없이 줄 번호만 붙여 돌려줍니다. 화면 표시를 확인할 때 씁니다.

## 명령어

| 명령 | 하는 일 |
|---|---|
| `bun run install-agent` | 데몬을 launchd에 등록하고 실행 |
| `bun run restart-agent` | 데몬 다시 시작 (`.env`를 바꾼 뒤) |
| `bun run uninstall-agent` | 데몬 등록 해제 |
| `bun run logs` | 데몬 로그 보기 (`Ctrl+C`로 종료) |
| `bun run update` | 새 릴리스를 바로 확인하고 업데이트 |
| `bun run status` | Spotify 버전과 패치 상태 확인 |
| `bun run apply` | 확장을 직접 주입 (보통은 데몬이 알아서 함) |
| `bun run restore` | 주입한 스크립트를 빼고 원래대로 되돌림 |
| `bun run dev` | 개발 모드 데몬 실행 |
| `bun run test` | 테스트 실행 |

`bun run status`의 `patchedHash`가 `null`이면 패치가 풀린 상태이고, 값이 있으면 그 해시의 확장이 들어가 있는 상태입니다.

## 자동 업데이트

데몬이 GitHub의 최신 릴리스를 확인해서 새 버전이 있으면 스스로 업데이트합니다.

1. Spotify를 끄거나 켤 때, 데몬이 시작될 때, 그리고 6시간마다 `releases/latest`를 확인합니다. GitHub API 한도 때문에 Spotify를 끄고 켤 때는 1분에 한 번, 나머지는 10분에 한 번까지만 확인합니다.
2. `vX.Y.Z` 형식의 정식 릴리스가 지금 버전보다 새로우면, 그 태그를 받아 앞으로만 옮깁니다(fast-forward).
3. 데몬이 새 코드로 다시 시작되고, Spotify 안의 확장도 새 버전으로 바꿔 넣습니다.
4. Spotify를 다시 켜면 새 확장이 로드됩니다.

평소에는 **Spotify를 한 번 껐다 켜면** 끌 때 업데이트되고, 켤 때 새 버전이 로드됩니다. 업데이트가 끝나기 전에 너무 빨리 다시 켜면, 그다음 재시작 때 새 버전이 적용됩니다.

다음 경우에는 업데이트하지 않고 로그만 남깁니다.

- 추적 중인 파일에 고친 내용이 있을 때 (`local changes`). `.env` 같은 추적하지 않는 파일은 상관없습니다.
- 릴리스에 없는 로컬 커밋이 있을 때 (`local commits are not in the release`)
- `git clone`으로 받은 폴더가 아닐 때 (`not a git checkout`)

지금 버전은 `bun run version`, 즉시 업데이트는 `bun run update`로 합니다. 코드를 직접 고쳐 쓰고 있다면 `.env`에 `SLT_AUTO_UPDATE=0`을 넣어 끕니다.

## Spotify 업데이트

Spotify가 업데이트되면 앱 전체가 교체되어 패치가 풀립니다. 데몬이 30초 안에 알아채고 다시 주입하며, 새 버전의 원본도 따로 백업합니다. Spotify가 켜져 있는 동안 다시 주입되었다면 다음에 Spotify를 켤 때부터 번역이 붙습니다.

## 문제 해결

로그부터 봅니다. 로그에는 곡 ID, 번역된 줄 수, 걸린 시간만 남고 가사 내용은 남지 않습니다.

```bash
bun run logs
```

| 로그 또는 증상 | 원인과 대응 |
|---|---|
| `listening on ...`만 있고 요청이 없음 | 가사 화면이 닫혀 있거나, Spotify를 다시 켜지 않아 확장이 로드되지 않았습니다. `bun run status`로 패치를 확인하고 Spotify를 다시 켭니다 |
| `translated <곡 ID> 37/39 lines` | 정상입니다. 번역되지 않은 줄은 빈 줄, 기호 줄, 이미 한국어인 줄입니다 |
| `cancelled <곡 ID>` | 번역 중에 곡을 넘겨서 취소된 것입니다. 정상입니다 |
| `... is not set` | `.env`에 해당 키가 없습니다. 넣은 뒤 `bun run restart-agent` |
| `codex gateway 401`, `openrouter 401` | 키가 틀렸거나 폐기되었습니다 |
| `codex gateway 503` | 게이트웨이의 Codex 로그인이 만료되었습니다. 게이트웨이 관리 화면에서 다시 로그인합니다 |
| `gateway unreachable` | 게이트웨이에 닿지 않습니다. 같은 LAN에 있는지, 방화벽이 이 기기를 허용하는지 확인합니다 |
| `openrouter 402` | OpenRouter 크레딧이 부족합니다 |
| `patch check failed` | 앱 폴더를 고칠 권한이 없을 수 있습니다. 터미널과 Bun에 "앱 관리" 권한을 줍니다 |
| `update check on spotify quit: v0.2.1 is up to date` | 확인했고 이미 최신입니다 |
| `updated 0.2.0 to v0.2.1 on spotify quit` | 자동 업데이트가 끝났습니다. Spotify를 켜면 새 버전이 로드됩니다 |
| `update to vX.Y.Z skipped on ...` | 뒤에 붙은 이유 때문에 건너뛰었습니다. [자동 업데이트](#자동-업데이트)를 봅니다 |
| `update check failed` | GitHub에 닿지 않았거나 API 한도에 걸렸습니다. 다음 확인 때 다시 시도합니다 |

게이트웨이 연결만 따로 확인하려면 다음을 실행합니다.

```bash
curl http://192.168.0.9:8080/health
```

## 제거

```bash
bun run uninstall-agent
bun run restore
```

그다음 Spotify를 다시 켜면 원래 상태로 돌아갑니다. 원본 백업과 번역 캐시는 `~/Library/Application Support/spotify-lyrics-translator/`에 남아 있으니 필요 없으면 지웁니다. `restore`가 실패하면 그 폴더의 `xpui-<버전>.spa`를 `/Applications/Spotify.app/Contents/Resources/Apps/xpui.spa`로 복사하면 됩니다.

## 개발

설치된 데몬과 같은 포트를 쓰므로 먼저 등록을 해제합니다.

```bash
bun run uninstall-agent
SLT_TRANSLATOR=mock bun run dev
```

개발 모드에서는 확장 대신 개발용 로더가 주입됩니다. Spotify를 한 번만 다시 켜면, 이후에는 `extension/lyrics-translator.js`를 저장할 때마다 Spotify 화면이 알아서 새로고침됩니다. 로더는 화면의 가사 줄 수와 번역 줄 수를 데몬 로그로 보냅니다.

개발을 마치면 `bun run install-agent`로 되돌립니다. 데몬이 개발용 로더를 확장으로 다시 바꿔 넣습니다.

### 구조

```
src/
  config.ts       경로, 포트, 출처 같은 설정값
  patcher.ts      xpui.spa 주입, 복원, 상태 확인, 원본 백업
  translator.ts   번역기(codex, OpenRouter, Claude, mock), 캐시, 요청 취소
  daemon.ts       로컬 번역 서버와 자동 재패치
  updater.ts      GitHub 릴리스 확인과 fast-forward 업데이트
  cli.ts          명령어와 launchd 등록
extension/
  lyrics-translator.js   Spotify에 주입되는 확장
  dev-loader.js          개발 모드 로더
test/                    bun test
```

## 보안과 주의 사항

- **API 키**: `.env`에만 두고 저장소에 올리지 않습니다. `.gitignore`에 들어 있습니다.
- **데몬 접근 제한**: 데몬은 `127.0.0.1`에서만 받고, 출처가 `https://xpui.app.spotify.com`인 요청만 처리합니다. 일반 브라우저의 웹 페이지가 데몬을 불러 키를 쓰는 것을 막기 위해서입니다.
- **codex-gateway 평문 전송**: HTTP라서 키와 가사 원문이 LAN에 평문으로 흐릅니다.
- **외부 전송**: 가사 원문과 곡 ID가 고른 번역기(codex-gateway를 거친 Codex, OpenRouter, Anthropic)로 전송되고 사용량이 과금됩니다.
- **코드 서명**: 패치하는 동안에는 Spotify 앱의 코드 서명 검증이 실패합니다. 이미 설치된 앱은 실행할 때마다 서명을 다시 검사하지 않아서 실행에는 문제가 없습니다.
- **Spicetify와 함께 쓰기**: 같은 파일을 고치므로 `spicetify apply`와 함께 쓰면 충돌할 수 있습니다.
- **자동 업데이트**: GitHub 저장소 `yldst-dev/Spotify-Lyrics-Translator`의 정식 릴리스 코드를 받아 이 기기에서 실행합니다. 이 저장소를 믿을 수 없는 상황이면 `SLT_AUTO_UPDATE=0`으로 끕니다.
- **포트 변경**: 포트를 바꾸려면 `SLT_PORT`와 `extension/lyrics-translator.js`의 `API`를 함께 바꿔야 합니다.

## 한계

- 가사 화면이 닫혀 있으면 번역하지 않으므로, 처음 듣는 곡은 가사를 연 뒤 잠시 기다려야 합니다.
- 번역은 곡 전체를 한 번에 받아서 붙입니다. 조각 단위로 먼저 보여 주지는 않습니다.
- Spotify가 가사 화면 구조(`data-testid="lyrics-line"`)나 가사 API 경로(`color-lyrics/v2`)를 바꾸면 번역이 붙지 않습니다. 이때도 Spotify 원래 가사 화면은 그대로 나옵니다.
