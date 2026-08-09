# maple-pod / resources

Maple Pod 的資源建置與發佈管線。負責把 MapleStory BGM 的清單、音檔、標記圖與背景圖，
整理成前端可直接取用的靜態資源，並發佈到本 repo 的 `gh-pages` 分支。

前端不透過 GitHub Pages 取用（本 repo 未啟用 Pages），而是走 jsDelivr／raw.githubusercontent：

```
https://cdn.jsdelivr.net/gh/maple-pod/resources@gh-pages/data.json
```

## 產出物

發佈到 `gh-pages` 的內容：

| 路徑 | 說明 |
| --- | --- |
| `data.json` | 曲目 metadata（含 `duration`）＋ 所有標記圖的 deflate 資料，前端用 fflate 解開 |
| `bgm/*.mp3` | 音檔，檔名取自 db 的 `filename` 欄位 |
| `mark/*.png` | 標記圖原檔 |
| `bg/*.jpg` | 背景圖（1920×1080） |
| `bg/bg.json` | 背景圖清單＋壓縮過的縮圖預覽（240×135） |

## 前置需求

**所有指令都在容器內執行，不要直接在主機上跑。** 管線依賴 `yt-dlp`、`ffprobe` 與
能執行 JS 的 runtime，主機上通常沒有這些工具，硬跑只會得到難以診斷的失敗。
`build` / `process-bgs` / `deploy` 會自行偵測執行環境，在主機上直接被擋下。

先建立環境映像（只需在 Dockerfile 變動時重做）：

```bash
./build-env.sh
```

再準備 `.env`（不進版控）：

```bash
GLOBAL_GIT_PATH=/path/to/your/.gitconfig   # 掛進容器的 git 身份，預設 $HOME/.gitconfig
CONTAINER_USER=yourname                     # 容器內的使用者名稱，預設取自 whoami
GH_TOKEN=github_pat_...                     # 發佈用，需要本 repo 的 contents:write 權限
```

## 操作流程

`dev.sh` 是唯一的入口：帶參數就在容器內執行該指令，不帶參數則進入互動 shell。

```bash
./dev.sh                        # 進入容器的互動 shell
./dev.sh pnpm install           # 第一次使用，或依賴有變動時

./dev.sh pnpm run build         # 抓取曲目：下載音檔與標記圖、ffprobe 取長度、產生 data.json
./dev.sh pnpm run process-bgs   # 背景圖：assets/bg/*.png → output/bg/*.jpg + bg.json
./dev.sh pnpm run deploy        # 把 output/ 提交並推送到 gh-pages

./dev.sh pnpm run lint
./dev.sh pnpm run lint:fix
./dev.sh pnpm run typecheck
```

> **一律用 `pnpm run <script>`。** `pnpm deploy` 會被 pnpm 內建的 `deploy` 子命令攔截，
> 不會執行本專案的腳本。

`dev.sh` 預設以 `sudo docker` 呼叫；不需要 sudo 的環境可以用 `DOCKER=docker ./dev.sh ...`。

`node_modules` 與 pnpm store 都落在專案目錄內，而容器一律把專案掛在 `/workspace`，
所以只要固定從容器操作，就不會出現 `ERR_PNPM_UNEXPECTED_STORE`（同一份 `node_modules`
被不同絕對路徑安裝過所導致）。反過來說，**在主機上跑過 `pnpm install` 會破壞這個一致性**。

編輯器的 ESLint 整合仍在主機上運作（`lint` / `typecheck` 沒有容器限制，它們不需要外部工具），
命令列操作則統一走 `./dev.sh`。

## 增量建置

`build` 是增量的，狀態記在 workspace 根目錄的 `.build-state.json`（已被 gitignore）：

- 每完成一個項目就寫入一次，中斷後重跑會從斷點續做。
- 每次啟動會先跟 `output/` 的實際檔案對帳：檔案被手動刪掉的項目會重新下載，
  手動放進去的檔案會被登記為已完成。
- 失敗的項目記在 `failedBgms` / `failedMarks`，下次執行會自動重試。
- 有任何失敗時會在根目錄產生 `error-<timestamp>.log`，且行程以 exit code 1 結束。

想完整重建，刪掉 `.build-state.json` 與 `output/` 對應的檔案即可。

中途中斷是安全的：未完成的下載會留下 `output/bgm/_tmp_*`，下次啟動時會自動清掉。

## 發佈的行為

`deploy` 把 `output/` 當成獨立的 git repo（orphan `gh-pages` 分支）操作：

- JSON 與 PNG 先進一個 commit，MP3 每 100 個一批，避免單一 commit 過大。
- **不使用 `--force`**。若本機 `output/` 的歷史與 `origin/gh-pages` 分歧，推送會直接失敗，
  需要人工判斷後處理，不會靜默覆蓋遠端。
- `GH_TOKEN` 只在 `git push` 當下以參數傳入，**不會寫進 `output/.git/config`**；
  腳本每次執行也會把 remote 重設回不帶 token 的 URL，順手清掉舊版留下的憑證。

## 疑難排解

**yt-dlp 抓取失敗、或出現 `No supported JavaScript runtime` 之類的警告**

YouTube 端變動頻繁，yt-dlp 需要跟著更新。重建映像即可取得最新版：

```bash
./build-env.sh
```

若最新版本本身有問題，可以釘回已知可用的版本：

```bash
YTDLP_VERSION=2026.01.15 ./build-env.sh
```

`build-resources.ts` 以 `jsRuntimes: 'node'` 讓 yt-dlp 使用映像內建的 Node 作為 JS runtime，
因此不需要另外安裝 deno。

**推送被拒（non-fast-forward）**

代表 `output/` 的本機歷史與 `origin/gh-pages` 對不上，通常是 `output/` 被重建過。
確認遠端內容後再決定要 rebase、合併，還是刻意重建分支——腳本不會替你做這個決定。

## 已知限制

- `gh-pages` 分支目前約 2.4 GB 且只增不減，已超過 GitHub 建議的 1 GB。
  短期還能運作，但曲目再成長就需要改變發佈方式（例如每次重建 orphan 分支壓掉歷史，
  或改用物件儲存）。
- CI（`.github/workflows/ci.yml`）只跑 lint 與 typecheck。
  資源抓取刻意不上 GitHub runner：YouTube 對資料中心 IP 封鎖嚴重，且產出量不適合 hosted runner。
