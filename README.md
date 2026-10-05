# 遊戲入口主控制器（Game Hub）

測試機上的單一入口網站「更萊姆遊戲」：同事開一個網址，就能看到所有遊戲的狀態並進入；主控制器負責把遊戲開起來、當掉時重開、維護時關掉。

- 入口網頁（黑白 cyberpunk 風格）：遊戲列表有縮圖、名稱與狀態（運行中、在線人數、版本、維護公告），加上「其他連結」
- 遊戲列表就是 `hub.config.json` 的 `games`：新增遊戲只要加一筆、把縮圖放進 `assets/`，網頁不用改
- 管理模式（密碼）：啟動、停止、重啟、接管手動開的視窗、看各遊戲的紀錄
- 維護：在遊戲資料夾放 `maintenance.txt`（內容就是公告）；有局在打會等打完才關，刪掉檔案就自動開回來
- 遊戲以獨立行程執行、輸出寫到 `logs/<id>.log`：主控制器重開不會中斷遊戲，起來後自動接回
- Windows 開機自動啟動：`install-autostart.bat` 建立以 SYSTEM 執行的排程工作

不需要 npm install：打包後只有一個 `dist/hub.js`（只用 Node.js 內建模組）加入口網頁。

## 環境

Node.js 22.18.0（與測試機相同，`nvm use` 會讀 `.nvmrc`）。

```bash
npm install
```

## 開發

```bash
npm run dev
```

會讀專案根目錄的 `hub.config.json`（不進 git；沒有的話從 `hub.config.example.json` 建立並產生管理密碼），入口在 <http://localhost:4300>。

```bash
npm test
```

```bash
npm run typecheck
```

## 部署

```bash
npm run package
```

產出 `release/game-hub/`：`dist/`、`assets/`（縮圖）、啟動與安裝用的 `.bat`、`hub.config.example.json`、`README-DEPLOY.txt`（給操作測試機的人看的中文說明）。套件不含 `hub.config.json`，所以覆蓋新版不會蓋掉測試機上的設定。

把資料夾放在各遊戲資料夾的同一層（例如 `games/GameHub` 旁邊是 `games/BnB`），測試機上以系統管理員執行一次 `open-firewall.bat` 與 `install-autostart.bat`。

## 設定（hub.config.json）

| 欄位 | 說明 |
| --- | --- |
| `port` | 入口的埠，預設 4300 |
| `title` | 網站名稱，預設「更萊姆遊戲」 |
| `adminPassword` | 管理模式密碼 |
| `games[]` | 遊戲：`id`、`name`、`image`、`desc`、`port`、`path`、`dir`、`command`、`args`、`env`、`health`、`autoStart` |
| `links[]` | 其他連結：`name`、`url`、`desc` |

- `image` 是 `assets/` 裡的縮圖檔名（200x200，英數字檔名，png/jpg/webp/gif/svg），由 `/assets/<檔名>` 提供；網址帶檔案修改時間，換圖不用清快取。沒有縮圖時顯示名稱的第一個字。
- 有 `command` 的遊戲由主控制器啟動（`"node"` 代表執行主控制器的那個 Node.js），啟動時設定 `PORT` 環境變數；沒有 `command` 的只顯示連線狀態與連結。
- `health` 是健康檢查網址，回傳 2xx 就算正常；JSON 裡的 `version`、`online`、`playing` 會顯示在入口，`playing` 大於 0 時維護會等這局結束。
- 存檔後主控制器會自己重開套用（約 5 秒，遊戲不受影響）；寫錯的話會在 `logs/hub.log` 說明並繼續用舊設定。

## 結構

```text
src/      config（設定檢查）、game（單一遊戲的監看與開關）、hub（全部遊戲與狀態檔）、server（入口與 API）、probe（健康檢查、埠與行程）
public/   入口網頁（單一 HTML，不需要建置）
assets/   遊戲列表的縮圖；只有 bnb.png 進 git，其他遊戲的圖只放在本機與測試機
deploy/   Windows 啟動、開機自動啟動、防火牆的 .bat 與中文部署說明
tests/    以假遊戲（tests/fixtures/fake-game.mjs）跑真實行程的測試
```
