/* Clawd Mobile i18n — self-contained 5-language dictionary + helpers.
 *
 * Self-contained (not a server fetch) on purpose: the PWA is offline-capable, so
 * text must render without the network. The DEFAULT language follows the desktop
 * app's `lang` setting (served via /api/connection-info); a manual pick in the PWA
 * Settings overrides it and persists. Shared concepts (state/event labels,
 * time-ago) reuse the desktop wording from src/i18n.js for consistency.
 *
 * Dual export: attaches window.CLAWD_I18N in the browser and module.exports in node
 * (so the dictionary can be unit-tested for completeness).
 */
(function (root) {
  "use strict";

  var SUPPORTED_LANGS = ["en", "zh", "zh-TW", "ko", "ja"];
  var LANG_NATIVE_NAMES = {
    en: "English",
    zh: "简体中文",
    "zh-TW": "繁體中文",
    ko: "한국어",
    ja: "日本語",
  };
  var STORAGE_KEY = "clawd-lang";

  var I18N = {
    // ── Approvals ──
    approval_pending:   { en: "Pending approvals", zh: "待处理审批", "zh-TW": "待處理審批", ko: "대기 중인 승인", ja: "保留中の承認" },
    approval_kind:      { en: "Approval", zh: "审批", "zh-TW": "審批", ko: "승인", ja: "承認" },
    approval_allow:     { en: "Allow", zh: "允许", "zh-TW": "允許", ko: "허용", ja: "許可" },
    approval_deny:      { en: "Deny", zh: "拒绝", "zh-TW": "拒絕", ko: "거부", ja: "拒否" },
    approval_pair_hint: { en: "Pair this device in Settings to approve", zh: "需先在设置中配对设备才能审批", "zh-TW": "需先在設定中配對裝置才能審批", ko: "승인하려면 설정에서 이 기기를 페어링하세요", ja: "承認するには設定でこの端末をペアリングしてください" },
    approval_secure_hint: { en: "Enable Secure (HTTPS) on the desktop to approve from this device", zh: "需在桌面端启用安全连接 (HTTPS) 后才能在此设备审批", "zh-TW": "需在桌面端啟用安全連線 (HTTPS) 後才能在此裝置審批", ko: "이 기기에서 승인하려면 데스크톱에서 보안 연결(HTTPS)을 활성화하세요", ja: "この端末で承認するにはデスクトップで安全な接続 (HTTPS) を有効にしてください" },
    approval_kind_question: { en: "Question", zh: "提问", "zh-TW": "提問", ko: "질문", ja: "質問" },
    approval_kind_plan: { en: "Plan", zh: "计划", "zh-TW": "計畫", ko: "계획", ja: "計画" },
    approval_pill_pending: { en: "{n} pending", zh: "{n} 个待处理", "zh-TW": "{n} 個待處理", ko: "{n}건 대기 중", ja: "{n} 件保留中" },
    approval_back_to_menu: { en: "Back to menu", zh: "返回菜单", "zh-TW": "返回選單", ko: "메뉴로 돌아가기", ja: "メニューに戻る" },
    approval_submit: { en: "Submit", zh: "提交", "zh-TW": "提交", ko: "제출", ja: "送信" },
    approval_other: { en: "Other…", zh: "其他…", "zh-TW": "其他…", ko: "기타…", ja: "その他…" },
    approval_other_placeholder: { en: "Type your answer", zh: "输入你的回答", "zh-TW": "輸入你的回答", ko: "답변을 입력하세요", ja: "回答を入力" },
    approval_approve: { en: "Approve", zh: "批准", "zh-TW": "核准", ko: "승인", ja: "承認" },
    approval_reject: { en: "Reject", zh: "拒绝", "zh-TW": "拒絕", ko: "거부", ja: "却下" },
    approval_suggest_changes: { en: "Suggest changes", zh: "建议修改", "zh-TW": "建議修改", ko: "변경 제안", ja: "変更を提案" },
    approval_feedback_placeholder: { en: "Describe the changes you'd like", zh: "描述你希望的修改", "zh-TW": "描述你希望的修改", ko: "원하는 변경 사항을 설명하세요", ja: "希望する変更を説明してください" },
    approval_send_feedback: { en: "Send feedback", zh: "发送反馈", "zh-TW": "傳送回饋", ko: "피드백 보내기", ja: "フィードバックを送信" },

    // ── Session detail ──
    detail_context:     { en: "Context usage", zh: "上下文用量", "zh-TW": "上下文用量", ko: "컨텍스트 사용량", ja: "コンテキスト使用量" },
    detail_output:      { en: "Recent output", zh: "最近输出", "zh-TW": "最近輸出", ko: "최근 출력", ja: "最近の出力" },
    detail_events:      { en: "Recent events", zh: "最近事件", "zh-TW": "最近事件", ko: "최근 이벤트", ja: "最近のイベント" },
    detail_focus:       { en: "Focus on desktop", zh: "在桌面端聚焦", "zh-TW": "在桌面端聚焦", ko: "데스크톱에서 포커스", ja: "デスクトップでフォーカス" },
    detail_back:        { en: "Back", zh: "返回", "zh-TW": "返回", ko: "뒤로", ja: "戻る" },
    detail_loading:     { en: "Loading…", zh: "加载中…", "zh-TW": "載入中…", ko: "불러오는 중…", ja: "読み込み中…" },

    // ── Notifications ──
    notif_section:      { en: "Notifications", zh: "通知", "zh-TW": "通知", ko: "알림", ja: "通知" },
    notif_enable:       { en: "Enable notifications", zh: "开启推送通知", "zh-TW": "開啟推播通知", ko: "알림 켜기", ja: "通知を有効にする" },
    notif_disable:      { en: "Disable notifications", zh: "关闭推送通知", "zh-TW": "關閉推播通知", ko: "알림 끄기", ja: "通知を無効にする" },
    notif_hint:         { en: "Get a push when an approval is requested", zh: "在审批请求到来时收到推送", "zh-TW": "在審批請求到來時收到推播", ko: "승인 요청이 오면 푸시를 받습니다", ja: "承認リクエスト時にプッシュを受け取ります" },
    notif_denied:       { en: "Notification permission denied — enable it in system settings", zh: "通知权限被拒绝，请在系统设置中开启", "zh-TW": "通知權限被拒絕，請在系統設定中開啟", ko: "알림 권한이 거부되었습니다 — 시스템 설정에서 활성화하세요", ja: "通知の権限が拒否されました — システム設定で有効にしてください" },
    notif_unsupported:  { en: "Push notifications are not supported on this device", zh: "此设备不支持推送通知", "zh-TW": "此裝置不支援推播通知", ko: "이 기기는 푸시 알림을 지원하지 않습니다", ja: "この端末はプッシュ通知に対応していません" },
    notif_enabled_toast:  { en: "Notifications enabled", zh: "已开启推送", "zh-TW": "已開啟推播", ko: "알림이 켜졌습니다", ja: "通知を有効にしました" },
    notif_disabled_toast: { en: "Notifications disabled", zh: "已关闭推送", "zh-TW": "已關閉推播", ko: "알림이 꺼졌습니다", ja: "通知を無効にしました" },
    notif_error:        { en: "Couldn't enable notifications — please try again", zh: "开启推送失败，请重试", "zh-TW": "開啟推播失敗，請重試", ko: "알림을 켜지 못했습니다 — 다시 시도하세요", ja: "通知を有効にできませんでした — もう一度お試しください" },

    // ── Pairing ──
    pair_section:       { en: "Device pairing", zh: "设备配对", "zh-TW": "裝置配對", ko: "기기 페어링", ja: "端末のペアリング" },
    pair_paired:        { en: "Paired", zh: "已配对", "zh-TW": "已配對", ko: "페어링됨", ja: "ペアリング済み" },
    pair_unpaired:      { en: "Not paired", zh: "未配对", "zh-TW": "未配對", ko: "페어링 안 됨", ja: "未ペアリング" },
    pair_hint:          { en: "Once paired, the device stays connected across token rotation", zh: "配对后即使令牌轮换也无需重连", "zh-TW": "配對後即使權杖輪換也無需重新連線", ko: "페어링하면 토큰이 교체되어도 연결이 유지됩니다", ja: "ペアリングすればトークンが更新されても接続は維持されます" },
    pair_disconnect:    { en: "Disconnect this desktop", zh: "断开此桌面端", "zh-TW": "中斷此桌面端", ko: "이 데스크톱 연결 해제", ja: "このデスクトップを切断" },
    pair_disconnect_confirm: { en: "Tap again to disconnect", zh: "再次点击以断开", "zh-TW": "再次點擊以中斷", ko: "다시 탭하여 연결 해제", ja: "もう一度タップして切断" },
    pair_enter_title:   { en: "Pair this device", zh: "配对此设备", "zh-TW": "配對此裝置", ko: "이 기기 페어링", ja: "この端末をペアリング" },
    pair_enter_hint:    { en: "Enter the code shown on the desktop (Settings → Mobile).", zh: "输入桌面端「设置 → 移动端」中显示的配对码。", "zh-TW": "輸入桌面端「設定 → 行動裝置」中顯示的配對碼。", ko: "데스크톱(설정 → 모바일)에 표시된 코드를 입력하세요.", ja: "デスクトップ（設定 → モバイル）に表示されたコードを入力してください。" },
    code_connect:       { en: "Connect", zh: "连接", "zh-TW": "連線", ko: "연결", ja: "接続" },
    code_invalid:       { en: "That code doesn't look right — check the 8 characters.", zh: "配对码格式不正确，请检查这 8 位字符。", "zh-TW": "配對碼格式不正確，請檢查這 8 位字元。", ko: "코드가 올바르지 않습니다 — 8자리를 확인하세요.", ja: "コードが正しくないようです — 8文字を確認してください。" },
    code_rejected:      { en: "Code rejected or expired — get a fresh one on the desktop.", zh: "配对码无效或已过期，请在桌面端获取新的配对码。", "zh-TW": "配對碼無效或已過期，請在桌面端取得新的配對碼。", ko: "코드가 거부되었거나 만료되었습니다 — 데스크톱에서 새 코드를 받으세요.", ja: "コードが拒否されたか期限切れです — デスクトップで新しいコードを取得してください。" },
    pair_cta_settings:  { en: "Not paired — pair in Settings", zh: "未配对 — 请前往设置配对", "zh-TW": "未配對 — 請前往設定配對", ko: "페어링 안 됨 — 설정에서 페어링하세요", ja: "未ペアリング — 設定でペアリングしてください" },
    pair_go_settings:   { en: "Go to Settings", zh: "前往设置", "zh-TW": "前往設定", ko: "설정으로 이동", ja: "設定へ移動" },

    // ── QR re-point scanner ──
    scan_reconnect:     { en: "Scan QR to reconnect", zh: "扫码重新连接", "zh-TW": "掃碼重新連線", ko: "QR 스캔하여 재연결", ja: "QRをスキャンして再接続" },
    scan_title:         { en: "Scan pairing QR", zh: "扫描配对二维码", "zh-TW": "掃描配對 QR 碼", ko: "페어링 QR 스캔", ja: "ペアリングQRをスキャン" },
    scan_cancel:        { en: "Cancel", zh: "取消", "zh-TW": "取消", ko: "취소", ja: "キャンセル" },
    scan_hint:          { en: "Point at the QR on the desktop (Settings → Mobile)", zh: "对准桌面端（设置 → 移动端）显示的二维码", "zh-TW": "對準桌面端（設定 → 行動裝置）顯示的 QR 碼", ko: "데스크톱(설정 → 모바일)의 QR을 비추세요", ja: "デスクトップ（設定 → モバイル）のQRに向けてください" },
    scan_photo_hint:    { en: "Pick a photo of the QR code", zh: "选择二维码的照片", "zh-TW": "選擇 QR 碼的照片", ko: "QR 코드 사진을 선택하세요", ja: "QRコードの写真を選択してください" },
    scan_camera_denied: { en: "Camera unavailable — choose a photo of the QR instead", zh: "无法使用相机 — 请改为选择二维码照片", "zh-TW": "無法使用相機 — 請改為選擇 QR 碼照片", ko: "카메라를 사용할 수 없습니다 — QR 사진을 선택하세요", ja: "カメラを使用できません — QRの写真を選択してください" },
    scan_invalid:       { en: "Couldn't read a QR code — try again", zh: "未能识别二维码，请重试", "zh-TW": "無法辨識 QR 碼，請重試", ko: "QR 코드를 읽지 못했습니다 — 다시 시도하세요", ja: "QRコードを読み取れませんでした — もう一度お試しください" },
    scan_pick_photo:    { en: "Choose photo", zh: "选择照片", "zh-TW": "選擇照片", ko: "사진 선택", ja: "写真を選択" },
    scan_unsupported:   { en: "That QR isn't a Clawd address", zh: "该二维码不是 Clawd 地址", "zh-TW": "該 QR 碼不是 Clawd 位址", ko: "이 QR은 Clawd 주소가 아닙니다", ja: "このQRはClawdのアドレスではありません" },
    scan_not_lan:       { en: "That address isn't on your local network", zh: "该地址不在你的局域网内", "zh-TW": "該位址不在你的區域網路內", ko: "해당 주소는 로컬 네트워크에 없습니다", ja: "そのアドレスはローカルネットワーク上にありません" },
    scan_repointed:     { en: "Reconnecting to {addr}…", zh: "正在重新连接到 {addr}…", "zh-TW": "正在重新連線到 {addr}…", ko: "{addr}에 재연결 중…", ja: "{addr} に再接続中…" },

    // ── Navigation ──
    nav_sessions:       { en: "Sessions", zh: "会话", "zh-TW": "工作階段", ko: "세션", ja: "セッション" },
    nav_settings:       { en: "Settings", zh: "设置", "zh-TW": "設定", ko: "설정", ja: "設定" },

    // ── Sessions list / settings sections ──
    sessions_active:    { en: "Active sessions", zh: "活跃会话", "zh-TW": "進行中的工作階段", ko: "활성 세션", ja: "アクティブなセッション" },
    settings_connection: { en: "Connection", zh: "连接", "zh-TW": "連線", ko: "연결", ja: "接続" },
    settings_language:  { en: "Language", zh: "语言", "zh-TW": "語言", ko: "언어", ja: "言語" },
    settings_log:       { en: "Logs", zh: "日志", "zh-TW": "日誌", ko: "로그", ja: "ログ" },
    empty_connect:      { en: "Connect to the desktop to start monitoring", zh: "连接桌面端开始监控", "zh-TW": "連線到桌面端開始監控", ko: "데스크톱에 연결하여 모니터링을 시작하세요", ja: "デスクトップに接続して監視を開始" },
    empty_connect_hint: { en: "Configure the connection in Settings", zh: "前往设置页配置连接", "zh-TW": "前往設定頁設定連線", ko: "설정에서 연결을 구성하세요", ja: "設定で接続を構成してください" },

    // ── Toasts ──
    toast_connected:      { en: "Connected to desktop", zh: "已连接到桌面端", "zh-TW": "已連線到桌面端", ko: "데스크톱에 연결됨", ja: "デスクトップに接続しました" },
    toast_token_expired:  { en: "Token expired — please reconnect", zh: "令牌已过期，请重新连接", "zh-TW": "權杖已過期，請重新連線", ko: "토큰이 만료되었습니다 — 다시 연결하세요", ja: "トークンが失効しました — 再接続してください" },
    toast_reconnecting:   { en: "Still reconnecting… check the address, port, or that the desktop is running", zh: "仍在重连…请检查地址、端口或桌面端是否已开启", "zh-TW": "仍在重新連線…請檢查位址、連接埠或桌面端是否已開啟", ko: "계속 재연결 중… 주소·포트 또는 데스크톱 실행 여부를 확인하세요", ja: "再接続中… アドレス・ポート、またはデスクトップが起動しているか確認してください" },
    toast_token_rotated:  { en: "Token updated", zh: "令牌已更新", "zh-TW": "權杖已更新", ko: "토큰이 갱신되었습니다", ja: "トークンを更新しました" },

    // ── Completion notification ──
    notif_task_done_title: { en: "Task complete", zh: "任务完成", "zh-TW": "任務完成", ko: "작업 완료", ja: "タスク完了" },
    notif_task_done_body:  { en: "{label} finished its task", zh: "{label} 已完成任务", "zh-TW": "{label} 已完成任務", ko: "{label}의 작업이 완료되었습니다", ja: "{label} がタスクを完了しました" },

    // ── Focus ──
    focus_sent:         { en: "Focus request sent", zh: "已发送聚焦请求", "zh-TW": "已發送聚焦請求", ko: "포커스 요청을 보냈습니다", ja: "フォーカス要求を送信しました" },

    // ── Agent state labels (reused from the desktop's session states) ──
    state_error:        { en: "Error", zh: "错误", "zh-TW": "錯誤", ko: "오류", ja: "エラー" },
    state_attention:    { en: "Needs attention", zh: "需要关注", "zh-TW": "需要關注", ko: "주의 필요", ja: "要確認" },
    state_working:      { en: "Working", zh: "工作中", "zh-TW": "工作中", ko: "작업 중", ja: "作業中" },
    state_juggling:     { en: "Multitasking", zh: "多任务", "zh-TW": "多工", ko: "멀티태스킹", ja: "マルチタスク" },
    state_thinking:     { en: "Thinking", zh: "思考中", "zh-TW": "思考中", ko: "생각 중", ja: "思考中" },
    state_notification: { en: "Notification", zh: "通知", "zh-TW": "通知", ko: "알림", ja: "通知" },
    state_sweeping:     { en: "Cleaning up", zh: "清理中", "zh-TW": "清理中", ko: "정리 중", ja: "クリーンアップ中" },
    state_carrying:     { en: "Moving", zh: "搬运中", "zh-TW": "搬運中", ko: "이동 중", ja: "移動中" },
    state_idle:         { en: "Idle", zh: "空闲", "zh-TW": "閒置", ko: "대기", ja: "待機中" },
    state_sleeping:     { en: "Sleeping", zh: "休眠", "zh-TW": "睡眠", ko: "수면", ja: "休眠中" },

    // ── Connection status ──
    conn_connected:     { en: "Connected", zh: "已连接", "zh-TW": "已連接", ko: "연결됨", ja: "接続済み" },
    conn_connecting:    { en: "Connecting…", zh: "连接中…", "zh-TW": "連線中…", ko: "연결 중…", ja: "接続中…" },
    conn_reconnecting:  { en: "Reconnecting…", zh: "重连中…", "zh-TW": "重新連線中…", ko: "재연결 중…", ja: "再接続中…" },
    conn_auth_failed:   { en: "Auth failed", zh: "认证失败", "zh-TW": "驗證失敗", ko: "인증 실패", ja: "認証失敗" },

    // ── Hook event labels (reused from the desktop's eventLabel* strings) ──
    event_UserPromptSubmit:   { en: "Prompt submitted", zh: "已提交", "zh-TW": "已提交", ko: "프롬프트 전송", ja: "プロンプト送信" },
    event_PreToolUse:         { en: "Tool started", zh: "工具开始", "zh-TW": "工具開始", ko: "도구 시작", ja: "ツール開始" },
    event_PostToolUse:        { en: "Tool finished", zh: "工具完成", "zh-TW": "工具完成", ko: "도구 완료", ja: "ツール完了" },
    event_PostToolUseFailure: { en: "Tool failed", zh: "工具失败", "zh-TW": "工具失敗", ko: "도구 실패", ja: "ツール失敗" },
    event_Stop:               { en: "Response complete", zh: "回复完成", "zh-TW": "回覆完成", ko: "응답 완료", ja: "応答完了" },
    event_StopFailure:        { en: "Response failed", zh: "回复失败", "zh-TW": "回覆失敗", ko: "응답 실패", ja: "応答失敗" },
    event_SessionStart:       { en: "Session started", zh: "会话开始", "zh-TW": "工作階段開始", ko: "세션 시작", ja: "セッション開始" },
    event_SessionEnd:         { en: "Session ended", zh: "会话结束", "zh-TW": "工作階段結束", ko: "세션 종료", ja: "セッション終了" },
    event_PermissionRequest:  { en: "Permission needed", zh: "需要权限", "zh-TW": "需要權限", ko: "권한 필요", ja: "許可が必要" },
    event_Notification:       { en: "Notification", zh: "通知", "zh-TW": "通知", ko: "알림", ja: "通知" },
    event_SubagentStart:      { en: "Subagent started", zh: "子任务开始", "zh-TW": "子任務開始", ko: "하위 에이전트 시작", ja: "サブエージェント開始" },
    event_SubagentStop:       { en: "Subagent finished", zh: "子任务完成", "zh-TW": "子任務完成", ko: "하위 에이전트 완료", ja: "サブエージェント完了" },
    event_AfterAgent:         { en: "Agent turn ended", zh: "本轮结束", "zh-TW": "本輪結束", ko: "이번 턴 종료", ja: "このターンを終了" },
    event_ApiError:           { en: "API error", zh: "API 错误", "zh-TW": "API 錯誤", ko: "API 오류", ja: "API エラー" },
    event_Elicitation:        { en: "Question asked", zh: "需要回答", "zh-TW": "需要回應", ko: "질문 있음", ja: "質問あり" },
    event_WorktreeCreate:     { en: "Worktree created", zh: "创建 worktree", "zh-TW": "建立 worktree", ko: "Worktree 생성", ja: "Worktree 作成" },

    // ── Relative time (reused from the desktop time-ago strings) ──
    time_just_now:      { en: "just now", zh: "刚刚", "zh-TW": "剛剛", ko: "방금", ja: "たった今" },
    time_sec_ago:       { en: "{n}s ago", zh: "{n} 秒前", "zh-TW": "{n} 秒前", ko: "{n}초 전", ja: "{n}秒前" },
    time_min_ago:       { en: "{n}m ago", zh: "{n}分钟前", "zh-TW": "{n} 分鐘前", ko: "{n}분 전", ja: "{n}分前" },
    time_hr_ago:        { en: "{n}h ago", zh: "{n}小时前", "zh-TW": "{n} 小時前", ko: "{n}시간 전", ja: "{n}時間前" },
  };

  var _lang = "en";
  var _listeners = [];

  function normalize(lang) {
    return SUPPORTED_LANGS.indexOf(lang) !== -1 ? lang : null;
  }

  function mapNavigatorLang(nav) {
    var s = String(nav == null ? "" : nav).toLowerCase();
    if (!s) return null;
    if (/^zh-(tw|hk|mo)/.test(s) || /^zh-hant/.test(s)) return "zh-TW";
    if (/^zh/.test(s)) return "zh";
    if (/^ko/.test(s)) return "ko";
    if (/^ja/.test(s)) return "ja";
    if (/^en/.test(s)) return "en";
    return null;
  }

  // Precedence: a stored manual choice > the desktop default > the browser locale > en.
  function resolveLang(opts) {
    opts = opts || {};
    return normalize(opts.override)
      || normalize(opts.desktop)
      || mapNavigatorLang(opts.navigatorLang)
      || "en";
  }

  function getStored() {
    try { return normalize(localStorage.getItem(STORAGE_KEY)); } catch (e) { return null; }
  }

  function hasManualChoice() {
    return !!getStored();
  }

  function t(key, vars) {
    var entry = I18N[key];
    var s = entry ? (entry[_lang] || entry.en) : key;
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, function (m, name) {
        return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
      });
    }
    return s;
  }

  function getLang() { return _lang; }

  // opts.transient: change the active language without persisting it as a manual
  // choice (used for the desktop-derived default).
  function setLang(lang, opts) {
    _lang = normalize(lang) || "en";
    if (!(opts && opts.transient)) {
      try { localStorage.setItem(STORAGE_KEY, _lang); } catch (e) {}
    }
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = _lang;
    }
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](_lang); } catch (e) {}
    }
    return _lang;
  }

  // Synchronous boot resolution: a stored choice or the browser locale (the desktop
  // language isn't known yet — applyDesktopDefault refines it once it arrives).
  function init() {
    var navLang = (typeof navigator !== "undefined") ? (navigator.language || "") : "";
    _lang = resolveLang({ override: getStored(), navigatorLang: navLang });
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = _lang;
    }
    return _lang;
  }

  // Apply the desktop's language as the default, unless the user already picked one.
  function applyDesktopDefault(desktop) {
    if (hasManualChoice()) return _lang;
    var d = normalize(desktop);
    if (d && d !== _lang) setLang(d, { transient: true });
    return _lang;
  }

  function onChange(cb) {
    if (typeof cb === "function") _listeners.push(cb);
  }

  var api = {
    I18N: I18N,
    SUPPORTED_LANGS: SUPPORTED_LANGS,
    LANG_NATIVE_NAMES: LANG_NATIVE_NAMES,
    t: t,
    getLang: getLang,
    setLang: setLang,
    init: init,
    resolveLang: resolveLang,
    mapNavigatorLang: mapNavigatorLang,
    applyDesktopDefault: applyDesktopDefault,
    hasManualChoice: hasManualChoice,
    onChange: onChange,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CLAWD_I18N = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
