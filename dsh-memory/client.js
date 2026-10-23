/**
 * Client half of the dsh-memory plugin: the Settings → Memory page.
 *
 * Registers one `settings.section` occupant (id `memory`) that shows where the
 * memory database actually lives (directory, files, sizes) plus the live
 * statistics, and lets the user edit every runtime parameter the host half
 * exposes. All data goes through the host route family
 * `POST /memory/api/{state,save,reset,reveal}` — this module never touches the
 * filesystem, never parses YAML, and never decides on a default of its own.
 *
 * There is NO build step: `window.__ModuleLoader__` hands the module a
 * `require` and this file asks it for `react` only. No JSX (React.createElement
 * is aliased to `h`), no imports, no bundler, no sourcemap. The dictionaries
 * below are the only copy this page has; every field label and description is
 * keyed by the field key the host reports, so adding a field in
 * `src/settings.js` needs a dictionary entry here and nothing else.
 *
 * The host is the single source of truth: the page re-renders from the `state`
 * answer after every save/reset, so a value changed elsewhere (config file,
 * another tab) shows up on the next load instead of diverging here.
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-layered',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    /**
     * `react-dom` is part of the loader's static module map, so the data window
     * can be portaled to `<body>` and stay viewport-sized no matter which
     * scroll container or transformed ancestor the settings shell puts this
     * section in. A host that cannot resolve it still renders the window inline
     * (the fixed-position CSS is the fallback).
     */
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (reactDom !== null && reactDom !== undefined && typeof reactDom.createPortal === 'function') {
        createPortal = reactDom.createPortal
      }
    } catch {
      createPortal = null
    }

    /** Dictionary namespace owned by this plugin. */
    const NS = 'memory'
    /** Relative route family served by the host half (`src/api.js`). */
    const API_PREFIX = 'memory/api'
    /** A hung request must never freeze the settings page. */
    const REQUEST_TIMEOUT_MS = 15_000
    /** Exactly one style tag per page, tagged with this plugin id. */
    const STYLE_ID = 'dsh-memory/section'

    const zh = {
      // ── page chrome ──────────────────────────────────────────────────────
      section: '记忆',
      title: '记忆',
      description:
        '管理长期记忆的存储位置、运行参数与提炼策略。绝大多数改动保存后立即生效，标注「重启生效」的项需要重启 dsh。',
      loading: '正在读取记忆状态…',
      refresh: '刷新',
      retry: '重试',
      requestFailed: '请求失败',
      networkError: '无法连接 dsh 服务',
      pluginReady: '数据库就绪',
      pluginNotReady: '数据库未就绪',

      // ── actions / status ────────────────────────────────────────────────
      save: '保存',
      saving: '保存中…',
      saveWithCount: '保存（{n}）',
      discard: '撤销',
      resetBaseline: '恢复 YAML 基线',
      resetting: '恢复中…',
      confirmReset: '确定要清除设置页写入的所有参数，回到 YAML 与默认值吗？',
      confirmDiscard: '有未保存的改动，刷新会丢弃它们。继续吗？',
      savedLive: '已保存，立即生效',
      savedRestart: '已保存，{n} 项重启后生效',
      resetDone: '已恢复 YAML 基线',
      copied: '已复制路径',
      copyFailed: '复制失败，请手动选择路径',
      revealOpened: '已打开存储目录',
      revealFailed: '无法打开存储目录',
      errorTitle: '请求失败',

      // ── field badges ────────────────────────────────────────────────────
      sourceTitle: '当前取值来源',
      sourceDefault: '默认',
      sourceConfig: 'YAML',
      sourceSettings: '设置页',
      restartBadge: '重启生效',
      restartBadgeTitle: '该项保存后需要重启 dsh 才会生效。',
      resetField: '恢复默认',
      resetFieldTitle: '清除设置页保存的值，回落到 YAML 或默认值',
      pendingReset: '待恢复',
      unsavedBadge: '未保存',
      liveValueNow: '运行中使用：',
      emptyValue: '（空）',
      autoOption: '跟随默认',
      textPlaceholder: '留空跟随默认',
      invalidNumber: '需要 {min}–{max} 之间的数字',
      invalidNumberOnly: '需要数字',

      // ── storage card ────────────────────────────────────────────────────
      storageTitle: '记忆存储目录',
      storageHint: '数据库、WAL 文件与设置文件都在这一个目录里。',
      copyPath: '复制路径',
      openDir: '打开目录',
      files: '文件',
      noFiles: '目录里还没有文件',
      dbSize: '数据库体积',
      dbPath: '当前数据库路径',
      pendingDbPath: '重启后数据库',
      settingsPath: '设置文件路径',
      settingsMissing: '尚未创建',

      // ── statistics card ─────────────────────────────────────────────────
      statsTitle: '统计',
      statsTotal: '记忆总数',
      statsFacts: '事实',
      statsEpisodes: '片段',
      statsPending: '待提炼',
      statsScenes: '场景',
      statsPersonas: '人设',
      statsTokens: '词元消耗',

      // ── memory data manager (记忆数据) ──────────────────────────────────
      dataTitle: '记忆数据',
      dataHint: '查看、搜索、新增、编辑和删除已经存入记忆库的条目。',
      dataOpen: '管理数据',
      dataOpenTitle: '打开记忆数据管理窗口',
      dataModalTitle: '记忆数据',
      dataClose: '关闭',
      dataTotal: '共 {n} 条',
      dataMatched: '匹配 {n} 条',
      dataShown: '显示 {n} 条',
      dataRefresh: '刷新',
      dataSearchPlaceholder: '搜索标题、正文或标签…',
      dataSearch: '搜索',
      dataSearchClear: '清空搜索',
      dataKindAll: '全部类型',
      dataScopeAll: '全部范围',
      dataScopeGlobal: '全局',
      dataScopeProject: '项目',
      dataProjectAll: '全部项目',
      dataIncludeSuperseded: '含已取代',
      dataEmpty: '没有匹配的记忆',
      dataEmptyHint: '换个搜索词，或者新增一条。',
      dataLoading: '加载中…',
      dataPageOf: '第 {page} / {pages} 页',
      dataPrev: '上一页',
      dataNext: '下一页',
      dataEdit: '编辑',
      dataDelete: '删除',
      dataDeleted: '已删除 #{id}',
      dataCreated: '已新增记忆 #{id}',
      dataUpdated: '已保存 #{id}',
      dataMerged: '相同内容已存在，已更新 #{id}',
      dataConfirmDelete: '确定删除记忆 #{id}？此操作不可撤销。',
      dataRetry: '重试',
      dataNew: '新增记忆',
      dataFormNew: '新增记忆',
      dataFormEdit: '编辑记忆 #{id}',
      dataFieldText: '正文',
      dataFieldTextHint: '必填。这段文字会参与召回与检索。',
      dataFieldTitle: '标题',
      dataFieldTitlePlaceholder: '留空自动取首句',
      dataFieldKind: '类型',
      dataFieldScope: '范围',
      dataFieldProject: '项目',
      dataFieldProjectPlaceholder: '例如 menm',
      dataFieldTags: '标签',
      dataFieldTagsPlaceholder: '用逗号分隔，例如 pwsh, 发布',
      dataFieldPriority: '优先级',
      dataFieldPriorityHint: '0–100。类型为规则或画像且优先级 ≥ 85 时，会作为常驻记忆每轮注入。',
      dataFieldPinned: '常驻记忆',
      dataFieldPinnedHint: '开启后每轮都会注入，不依赖关键词命中。',
      dataBack: '返回列表',
      dataSave: '保存',
      dataSaving: '保存中…',
      dataRequired: '请填写正文',
      dataTooLong: '正文最多 {n} 个字符',
      dataProjectRequired: '项目范围必须填写项目名',
      dataVersion: '版本 {v}',
      dataUseCount: '使用 {n} 次',
      dataUpdatedAt: '更新于 {time}',
      dataPriorityShort: '优先级 {n}',
      dataPinnedBadge: '常驻',
      dataSupersededBadge: '已被取代',
      dataExpand: '展开',
      dataCollapse: '收起',
      dataHistoryTitle: '历史版本（{n}）',
      dataHistoryEmpty: '还没有历史版本',
      dataSource: '来源',
      dataIdPrefix: '#',
      'kind.persona': '用户画像',
      'kind.instruction': '硬性规则',
      'kind.work_fact': '工作事实',
      'kind.work_method': '工作方法',
      'kind.work_task': '工作任务',
      'kind.work_artifact': '产物',
      'kind.episodic': '情景',
      'kind.fact': '事实',
      'kind.episode': '片段',
      'kind.note': '备注',
      'source.manual': '手动',
      'source.extract': '自动提炼',
      'source.turn': '对话',
      'source.tool': '工具',
      'source.import': '导入',

      // ── parameter groups ────────────────────────────────────────────────
      paramsTitle: '参数',
      paramsHint: '共 {n} 项。改动立即生效，标注「重启生效」的项除外。',
      'group.recall': '召回',
      'group.capture': '捕获',
      'group.extraction': '提炼',
      'group.scenes': '场景',
      'group.persona': '人设',
      'group.vector': '向量',
      'group.storage': '存储',
      'group.advanced': '高级',
      'group.recall.description': '每轮注入什么、注入多少。',
      'group.capture.description': '对话要不要写进记忆库，写哪几层。',
      'group.extraction.description': '用模型把原始对话提炼成事实记忆。',
      'group.scenes.description': 'L2：把相关事实聚合成场景。',
      'group.persona.description': 'L3：跨会话的项目与全局画像。',
      'group.vector.description': '词法向量召回与混排权重。',
      'group.storage.description': '数据库文件位置，改动需要重启。',
      'group.advanced.description': '调试开关与技能注册。',

      // ── field labels (keyed by the host's field key) ────────────────────
      'recall.scope': '召回范围',
      'recall.maxItems': '单次注入条数',
      'recall.maxChars': '注入字符上限',
      'recall.minScore': '最低相关度',
      'recall.injectGlobalFacts': '注入全局事实',
      'recall.stableMaxChars': '稳定区上限',
      'core.enabled': '核心记忆',
      'core.maxItems': '核心记忆条数',
      'core.minPriority': '核心记忆阈值',
      capture: '捕获对话',
      'layers.l0': 'L0 原始轮次',
      'layers.l1': 'L1 事实',
      'layers.l2': 'L2 场景',
      'layers.l3': 'L3 人设',
      'extraction.enabled': '启用提炼',
      'extraction.everyN': '每 N 轮提炼',
      'extraction.idleMs': '空闲触发（毫秒）',
      'extraction.maxInputChars': '单次输入上限',
      'extraction.maxMemories': '单次产出上限',
      'extraction.maxAttempts': '尝试次数',
      'extraction.timeoutMs': '超时（毫秒）',
      'extraction.maxTokens': '最大词元',
      'extraction.provider': '提炼供应商',
      'extraction.model': '提炼模型',
      'scenes.enabled': '启用场景',
      'scenes.minFacts': '场景最少事实',
      'scenes.maxScenes': '场景上限',
      'scenes.halfLifeDays': '半衰期（天）',
      'persona.enabled': '启用人设',
      'persona.global': '全局人设',
      'persona.triggerEveryN': '每 N 轮更新',
      'persona.maxChars': '注入字符上限',
      'persona.targetChars': '项目人设目标长度',
      'persona.globalTargetChars': '全局人设目标长度',
      'persona.personaMaxTokens': '最大词元',
      'persona.personaTimeoutMs': '超时（毫秒）',
      'persona.personaReasoningEffort': '推理强度',
      'vector.enabled': '启用向量召回',
      'vector.weight': '向量权重',
      'vector.scanLimit': '扫描上限',
      'vector.prefilter': '预过滤',
      'vector.featureLimit': '特征上限',
      'storage.dbPath': '数据库路径',
      debug: '调试日志',
      'skills.enabled': '注册技能',
      'skills.dir': '技能目录',

      // ── field descriptions ─────────────────────────────────────────────
      'recall.scope.description': '只看当前项目，还是把全局记忆也算进来。',
      'recall.maxItems.description': '每轮最多注入几条记忆。',
      'recall.maxChars.description': '注入到上下文的字符上限。',
      'recall.minScore.description': '低于该分数的记忆不会被注入。',
      'recall.injectGlobalFacts.description': '把跨项目的事实也放进上下文。',
      'recall.stableMaxChars.description': '稳定注入区（项目人设等）的字符上限。',
      'core.enabled.description': '优先注入高优先级的核心记忆。',
      'core.maxItems.description': '每轮最多注入几条核心记忆。',
      'core.minPriority.description': '优先级达到该值才算核心记忆。',
      'capture.description': '关闭后不再记录任何对话。',
      'layers.l0.description': '保存原始对话轮次，供后续提炼。',
      'layers.l1.description': '从对话里提炼事实记忆。',
      'layers.l2.description': '把相关事实聚合成场景。',
      'layers.l3.description': '维护项目与全局人设摘要。',
      'extraction.enabled.description': '是否让模型自动提炼记忆。',
      'extraction.everyN.description': '攒够多少轮对话触发一次提炼。',
      'extraction.idleMs.description': '用户空闲多久后补一次提炼。',
      'extraction.maxInputChars.description': '一次提炼最多读入多少字符。',
      'extraction.maxMemories.description': '一次提炼最多写入几条记忆。',
      'extraction.maxAttempts.description': '提炼失败时最多尝试几次。',
      'extraction.timeoutMs.description': '单次提炼的超时时间。',
      'extraction.maxTokens.description': '提炼请求的 token 上限。',
      'extraction.provider.description': '留空跟随默认模型；改动需要重启。',
      'extraction.model.description': '留空跟随默认模型；改动需要重启。',
      'scenes.enabled.description': '生成并维护 L2 场景。',
      'scenes.minFacts.description': '一个场景至少要有几条事实。',
      'scenes.maxScenes.description': '最多保留多少个场景，超出后淘汰最弱的。',
      'scenes.halfLifeDays.description': '场景权重衰减一半所需的天数。',
      'persona.enabled.description': '生成项目与全局人设摘要。',
      'persona.global.description': '除项目人设外，还维护跨项目人设。',
      'persona.triggerEveryN.description': '攒够多少轮后重新生成人设。',
      'persona.maxChars.description': '人设注入到上下文的字符上限。',
      'persona.targetChars.description': '项目人设希望写到多长。',
      'persona.globalTargetChars.description': '全局人设希望写到多长。',
      'persona.personaMaxTokens.description': '人设生成请求的 token 上限。',
      'persona.personaTimeoutMs.description': '人设生成的超时时间。',
      'persona.personaReasoningEffort.description': '人设生成使用的推理强度，留空跟随默认。',
      'vector.enabled.description': '在全文检索之外加一路词法向量召回。',
      'vector.weight.description': '向量得分在混合排序中的权重。',
      'vector.scanLimit.description': '一次召回最多扫描多少条记录。',
      'vector.prefilter.description': '先用倒排特征粗筛再精算。',
      'vector.featureLimit.description': '查询时最多使用多少个特征。',
      'storage.dbPath.description': '留空使用 $DSH_HOME/memory/memory.db；改动需要重启。',
      'debug.description': '输出详细日志，便于排查问题。',
      'skills.enabled.description': '把包内技能注册给 agent；改动需要重启。',
      'skills.dir.description': '留空使用包内 ./skills；改动需要重启。',

      // ── enum options ────────────────────────────────────────────────────
      'option.recall.scope.project': '当前项目',
      'option.recall.scope.global': '全局',
      'option.persona.personaReasoningEffort.low': '低',
      'option.persona.personaReasoningEffort.medium': '中',
      'option.persona.personaReasoningEffort.high': '高',
      'option.persona.personaReasoningEffort.max': '最高',
    }

    const en = {
      // ── page chrome ──────────────────────────────────────────────────────
      section: 'Memory',
      title: 'Memory',
      description:
        'Storage location, runtime parameters, and extraction policy for long-term memory. Most changes apply as soon as they are saved; anything marked “Restart” needs a dsh restart.',
      loading: 'Reading memory state…',
      refresh: 'Refresh',
      retry: 'Retry',
      requestFailed: 'Request failed',
      networkError: 'Could not reach the dsh service',
      pluginReady: 'Database ready',
      pluginNotReady: 'Database not ready',

      // ── actions / status ────────────────────────────────────────────────
      save: 'Save',
      saving: 'Saving…',
      saveWithCount: 'Save ({n})',
      discard: 'Discard',
      resetBaseline: 'Restore YAML baseline',
      resetting: 'Restoring…',
      confirmReset: 'Clear every value written by this page and fall back to the YAML baseline and defaults?',
      confirmDiscard: 'There are unsaved changes; refreshing discards them. Continue?',
      savedLive: 'Saved — applied immediately',
      savedRestart: 'Saved — {n} change(s) take effect after a restart',
      resetDone: 'Restored the YAML baseline',
      copied: 'Path copied',
      copyFailed: 'Could not copy; select the path manually',
      revealOpened: 'Storage directory opened',
      revealFailed: 'Could not open the storage directory',
      errorTitle: 'Request failed',

      // ── field badges ────────────────────────────────────────────────────
      sourceTitle: 'Where the current value comes from',
      sourceDefault: 'Default',
      sourceConfig: 'YAML',
      sourceSettings: 'Settings',
      restartBadge: 'Restart',
      restartBadgeTitle: 'This value only takes effect after dsh restarts.',
      resetField: 'Reset',
      resetFieldTitle: 'Remove the value stored by this page; fall back to YAML or the default',
      pendingReset: 'Pending reset',
      unsavedBadge: 'Unsaved',
      liveValueNow: 'Running with: ',
      emptyValue: '(empty)',
      autoOption: 'Follow default',
      textPlaceholder: 'Empty follows the default',
      invalidNumber: 'Enter a number between {min} and {max}',
      invalidNumberOnly: 'Enter a number',

      // ── storage card ────────────────────────────────────────────────────
      storageTitle: 'Memory directory',
      storageHint: 'The database, its WAL files, and the settings file all live in this directory.',
      copyPath: 'Copy path',
      openDir: 'Open folder',
      files: 'Files',
      noFiles: 'No files in this directory yet',
      dbSize: 'Database size',
      dbPath: 'Database path',
      pendingDbPath: 'Database after restart',
      settingsPath: 'Settings file',
      settingsMissing: 'Not created yet',

      // ── statistics card ─────────────────────────────────────────────────
      statsTitle: 'Statistics',
      statsTotal: 'Total',
      statsFacts: 'Facts',
      statsEpisodes: 'Episodes',
      statsPending: 'Pending',
      statsScenes: 'Scenes',
      statsPersonas: 'Personas',
      statsTokens: 'Tokens',

      // ── memory data manager (记忆数据) ──────────────────────────────────
      dataTitle: 'Memory data',
      dataHint: 'Browse, search, add, edit, and delete the entries stored in the memory database.',
      dataOpen: 'Manage data',
      dataOpenTitle: 'Open the memory data window',
      dataModalTitle: 'Memory data',
      dataClose: 'Close',
      dataTotal: '{n} entries',
      dataMatched: '{n} matching',
      dataShown: 'Showing {n}',
      dataRefresh: 'Refresh',
      dataSearchPlaceholder: 'Search title, body, or tags…',
      dataSearch: 'Search',
      dataSearchClear: 'Clear search',
      dataKindAll: 'All kinds',
      dataScopeAll: 'All scopes',
      dataScopeGlobal: 'Global',
      dataScopeProject: 'Project',
      dataProjectAll: 'All projects',
      dataIncludeSuperseded: 'Include superseded',
      dataEmpty: 'No matching memories',
      dataEmptyHint: 'Try another search, or add one.',
      dataLoading: 'Loading…',
      dataPageOf: 'Page {page} / {pages}',
      dataPrev: 'Previous',
      dataNext: 'Next',
      dataEdit: 'Edit',
      dataDelete: 'Delete',
      dataDeleted: 'Deleted #{id}',
      dataCreated: 'Created memory #{id}',
      dataUpdated: 'Saved #{id}',
      dataMerged: 'That text already existed; updated #{id}',
      dataConfirmDelete: 'Delete memory #{id}? This cannot be undone.',
      dataRetry: 'Retry',
      dataNew: 'New memory',
      dataFormNew: 'New memory',
      dataFormEdit: 'Edit memory #{id}',
      dataFieldText: 'Body',
      dataFieldTextHint: 'Required. This is the text recall and search use.',
      dataFieldTitle: 'Title',
      dataFieldTitlePlaceholder: 'Empty derives it from the first sentence',
      dataFieldKind: 'Kind',
      dataFieldScope: 'Scope',
      dataFieldProject: 'Project',
      dataFieldProjectPlaceholder: 'e.g. menm',
      dataFieldTags: 'Tags',
      dataFieldTagsPlaceholder: 'Comma separated, e.g. pwsh, release',
      dataFieldPriority: 'Priority',
      dataFieldPriorityHint: '0–100. A rule or persona row at 85+ is injected as a standing memory on every turn.',
      dataFieldPinned: 'Always inject',
      dataFieldPinnedHint: 'Inject on every turn, without waiting for a lexical match.',
      dataBack: 'Back to list',
      dataSave: 'Save',
      dataSaving: 'Saving…',
      dataRequired: 'Body is required',
      dataTooLong: 'Body may have at most {n} characters',
      dataProjectRequired: 'Project scope needs a project name',
      dataVersion: 'Version {v}',
      dataUseCount: 'Used {n} times',
      dataUpdatedAt: 'Updated {time}',
      dataPriorityShort: 'Priority {n}',
      dataPinnedBadge: 'Always',
      dataSupersededBadge: 'Superseded',
      dataExpand: 'Expand',
      dataCollapse: 'Collapse',
      dataHistoryTitle: 'Earlier versions ({n})',
      dataHistoryEmpty: 'No earlier versions',
      dataSource: 'Source',
      dataIdPrefix: '#',
      'kind.persona': 'Persona',
      'kind.instruction': 'Rule',
      'kind.work_fact': 'Work fact',
      'kind.work_method': 'Method',
      'kind.work_task': 'Task',
      'kind.work_artifact': 'Artifact',
      'kind.episodic': 'Episodic',
      'kind.fact': 'Fact',
      'kind.episode': 'Episode',
      'kind.note': 'Note',
      'source.manual': 'Manual',
      'source.extract': 'Extracted',
      'source.turn': 'Turn',
      'source.tool': 'Tool',
      'source.import': 'Imported',

      // ── parameter groups ────────────────────────────────────────────────
      paramsTitle: 'Parameters',
      paramsHint: '{n} settings; changes apply immediately unless marked “Restart”.',
      'group.recall': 'Recall',
      'group.capture': 'Capture',
      'group.extraction': 'Extraction',
      'group.scenes': 'Scenes',
      'group.persona': 'Persona',
      'group.vector': 'Vector',
      'group.storage': 'Storage',
      'group.advanced': 'Advanced',
      'group.recall.description': 'What gets injected before every turn, and how much.',
      'group.capture.description': 'Whether conversations are recorded, and which layers.',
      'group.extraction.description': 'Distill raw turns into fact memories with the model.',
      'group.scenes.description': 'L2: group related facts into scenes.',
      'group.persona.description': 'L3: cross-session project and global profiles.',
      'group.vector.description': 'Lexical-vector recall and its blended weight.',
      'group.storage.description': 'Database file location; changes need a restart.',
      'group.advanced.description': 'Debug logging and skill registration.',

      // ── field labels (keyed by the host's field key) ────────────────────
      'recall.scope': 'Recall scope',
      'recall.maxItems': 'Items per turn',
      'recall.maxChars': 'Injection size limit',
      'recall.minScore': 'Minimum score',
      'recall.injectGlobalFacts': 'Include global facts',
      'recall.stableMaxChars': 'Stable section limit',
      'core.enabled': 'Core memories',
      'core.maxItems': 'Core items',
      'core.minPriority': 'Core priority floor',
      capture: 'Capture turns',
      'layers.l0': 'L0 raw turns',
      'layers.l1': 'L1 facts',
      'layers.l2': 'L2 scenes',
      'layers.l3': 'L3 persona',
      'extraction.enabled': 'Enable extraction',
      'extraction.everyN': 'Every N turns',
      'extraction.idleMs': 'Idle trigger (ms)',
      'extraction.maxInputChars': 'Input limit',
      'extraction.maxMemories': 'Memories per run',
      'extraction.maxAttempts': 'Attempts',
      'extraction.timeoutMs': 'Timeout (ms)',
      'extraction.maxTokens': 'Max tokens',
      'extraction.provider': 'Extraction provider',
      'extraction.model': 'Extraction model',
      'scenes.enabled': 'Enable scenes',
      'scenes.minFacts': 'Min facts',
      'scenes.maxScenes': 'Max scenes',
      'scenes.halfLifeDays': 'Half-life (days)',
      'persona.enabled': 'Enable persona',
      'persona.global': 'Global persona',
      'persona.triggerEveryN': 'Update every N turns',
      'persona.maxChars': 'Injection limit',
      'persona.targetChars': 'Project target length',
      'persona.globalTargetChars': 'Global target length',
      'persona.personaMaxTokens': 'Max tokens',
      'persona.personaTimeoutMs': 'Timeout (ms)',
      'persona.personaReasoningEffort': 'Reasoning effort',
      'vector.enabled': 'Enable vector recall',
      'vector.weight': 'Vector weight',
      'vector.scanLimit': 'Scan limit',
      'vector.prefilter': 'Pre-filter',
      'vector.featureLimit': 'Feature limit',
      'storage.dbPath': 'Database path',
      debug: 'Debug logs',
      'skills.enabled': 'Register skills',
      'skills.dir': 'Skills directory',

      // ── field descriptions ─────────────────────────────────────────────
      'recall.scope.description': 'Search this project only, or include global memories too.',
      'recall.maxItems.description': 'How many memories one turn may inject.',
      'recall.maxChars.description': 'Character budget for the injected block.',
      'recall.minScore.description': 'Memories scoring below this are skipped.',
      'recall.injectGlobalFacts.description': 'Inject facts learned in other projects too.',
      'recall.stableMaxChars.description': 'Character budget for the stable part (project persona and friends).',
      'core.enabled.description': 'Always inject high-priority core memories first.',
      'core.maxItems.description': 'How many core memories one turn may inject.',
      'core.minPriority.description': 'Minimum priority for a memory to count as core.',
      'capture.description': 'Turn this off to stop recording conversations.',
      'layers.l0.description': 'Keep raw turns as the input for extraction.',
      'layers.l1.description': 'Distill fact memories out of the conversation.',
      'layers.l2.description': 'Group related facts into scenes.',
      'layers.l3.description': 'Maintain project and global persona summaries.',
      'extraction.enabled.description': 'Let the model extract memories automatically.',
      'extraction.everyN.description': 'Run extraction after this many captured turns.',
      'extraction.idleMs.description': 'Run extraction after the user has been idle this long.',
      'extraction.maxInputChars.description': 'Maximum characters one extraction reads.',
      'extraction.maxMemories.description': 'Maximum memories one run may write.',
      'extraction.maxAttempts.description': 'How many times a failed extraction is retried.',
      'extraction.timeoutMs.description': 'Time budget for one extraction run.',
      'extraction.maxTokens.description': 'Token ceiling for the extraction request.',
      'extraction.provider.description': 'Empty follows the default model; changing it needs a restart.',
      'extraction.model.description': 'Empty follows the default model; changing it needs a restart.',
      'scenes.enabled.description': 'Build and maintain L2 scenes.',
      'scenes.minFacts.description': 'A scene needs at least this many facts.',
      'scenes.maxScenes.description': 'Cap on kept scenes; the weakest are evicted.',
      'scenes.halfLifeDays.description': "Days for a scene's weight to halve.",
      'persona.enabled.description': 'Generate project and global persona summaries.',
      'persona.global.description': 'Also maintain a cross-project persona.',
      'persona.triggerEveryN.description': 'Regenerate the persona after this many turns.',
      'persona.maxChars.description': 'Character budget for the injected persona.',
      'persona.targetChars.description': 'Target length of the project persona.',
      'persona.globalTargetChars.description': 'Target length of the global persona.',
      'persona.personaMaxTokens.description': 'Token ceiling for persona generation.',
      'persona.personaTimeoutMs.description': 'Time budget for persona generation.',
      'persona.personaReasoningEffort.description': 'Reasoning effort for persona generation; empty follows the default.',
      'vector.enabled.description': 'Add lexical-vector recall on top of full-text search.',
      'vector.weight.description': 'Weight of the vector score in the blended ranking.',
      'vector.scanLimit.description': 'Maximum records one recall may scan.',
      'vector.prefilter.description': 'Coarse-filter by inverted features before scoring.',
      'vector.featureLimit.description': 'Maximum features used per query.',
      'storage.dbPath.description': 'Empty uses $DSH_HOME/memory/memory.db; changing it needs a restart.',
      'debug.description': 'Emit verbose logs for troubleshooting.',
      'skills.enabled.description': 'Register bundled skills with the agent; needs a restart.',
      'skills.dir.description': 'Empty uses the bundled ./skills; needs a restart.',

      // ── enum options ────────────────────────────────────────────────────
      'option.recall.scope.project': 'This project',
      'option.recall.scope.global': 'Global',
      'option.persona.personaReasoningEffort.low': 'Low',
      'option.persona.personaReasoningEffort.medium': 'Medium',
      'option.persona.personaReasoningEffort.high': 'High',
      'option.persona.personaReasoningEffort.max': 'Max',
    }

    /**
     * The page's whole styling surface. Only `--dsw-alias-*` theme tokens are
     * consumed (each with a fallback), so the page follows the active light or
     * dark palette without owning any color of its own. Class prefix `dm_`
     * keeps every selector out of the way of the rest of the settings shell.
     */
    const CSS = `
.dm_section {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  max-width: 760px;
  color: var(--dsw-alias-label-primary);
}
.dm_head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 0 2px;
}
.dm_headText {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 auto;
  min-width: 0;
}
.dm_headSide {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding-top: 2px;
}
.dm_title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  line-height: 26px;
  color: var(--dsw-alias-label-primary);
}
.dm_intro {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
.dm_card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
}
.dm_cardHead {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.dm_cardText {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}
.dm_cardTitle {
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dm_cardHint {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dm_btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  padding: 3px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.dm_btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent));
}
.dm_btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.dm_btn:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dm_btnPrimary {
  border-color: transparent;
  background: var(--dsw-alias-state-business-primary);
  color: #fff;
}
.dm_btnPrimary:hover:not(:disabled) {
  background: var(--dsw-alias-state-business-primary);
  color: #fff;
  filter: brightness(1.06);
}
.dm_btnDanger {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.dm_btnDanger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
}
.dm_actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  margin-left: auto;
}
.dm_path {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 14px;
  line-height: 20px;
  word-break: break-all;
}
.dm_files {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dm_filesHead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dm_filesTotal {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.dm_file {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dm_fileName {
  flex: 1 1 auto;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.dm_fileSize {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
.dm_fileTime {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dm_kv {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  line-height: 18px;
}
.dm_kvLabel {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-tertiary);
}
.dm_kvValue {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.dm_stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
  gap: 8px;
}
.dm_stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.dm_statValue {
  font-size: 16px;
  font-weight: 600;
  line-height: 22px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}
.dm_statLabel {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dm_field {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 0;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dm_fieldFirst {
  padding-top: 2px;
  border-top: 0;
}
.dm_fieldText {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 220px;
  min-width: 0;
}
.dm_fieldLabel {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dm_key {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 16px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-tertiary);
}
.dm_fieldDesc {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dm_fieldNote {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-state-warn-primary);
  overflow-wrap: anywhere;
}
.dm_fieldSide {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex: 0 0 auto;
  margin-left: auto;
}
.dm_control {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dm_badges {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.dm_badge {
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.dm_badgeDefault {
  color: var(--dsw-alias-label-tertiary);
}
.dm_badgeConfig {
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent);
  color: var(--dsw-alias-label-secondary);
}
.dm_badgeSettings {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  color: var(--dsw-alias-state-business-primary);
}
.dm_badgeRestart {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}
.dm_badgeOk {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
  color: var(--dsw-alias-state-success-primary);
}
.dm_badgeDirty {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  color: var(--dsw-alias-state-business-primary);
}
.dm_input {
  box-sizing: border-box;
  width: 110px;
  padding: 3px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}
.dm_input::placeholder {
  color: var(--dsw-alias-label-tertiary);
}
.dm_input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dm_inputWide {
  width: 210px;
}
.dm_select {
  box-sizing: border-box;
  max-width: 220px;
  padding: 3px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}
.dm_select:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dm_select option {
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
}
.dm_switch {
  box-sizing: border-box;
  flex: 0 0 auto;
  width: 36px;
  height: 20px;
  padding: 0;
  position: relative;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease;
}
.dm_switch[data-on="true"] {
  border-color: transparent;
  background: var(--dsw-alias-state-business-primary);
}
.dm_switch:disabled {
  opacity: 0.6;
  cursor: default;
}
.dm_switch:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dm_switchThumb {
  box-sizing: border-box;
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, var(--dsw-alias-label-secondary));
  transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), background-color 0.18s ease;
}
.dm_switch[data-on="true"] .dm_switchThumb {
  transform: translateX(18px);
  background: var(--dsw-alias-label-primary-foreground, #fff);
}
.dm_linkBtn {
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--dsw-alias-state-business-primary);
  cursor: pointer;
  white-space: nowrap;
}
.dm_linkBtnActive {
  color: var(--dsw-alias-state-warn-primary);
}
.dm_linkBtn:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
  border-radius: 4px;
}
.dm_alert {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
.dm_alertBody {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}
.dm_alertTitle {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-weight: 600;
}
.dm_alertCode {
  padding: 0 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 400;
  line-height: 16px;
}
.dm_alertText {
  overflow-wrap: anywhere;
}
.dm_empty {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dm_loading {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dm_skeleton {
  gap: 10px;
}
.dm_skBar {
  height: 12px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  animation: dm-pulse 1.2s ease-in-out infinite;
}
.dm_skBarMid {
  width: 72%;
}
.dm_skBarShort {
  width: 44%;
}
@keyframes dm-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
.dm_bar {
  position: sticky;
  bottom: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1));
}
.dm_barSpacer {
  flex: 1 1 auto;
}
.dm_groupHead {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 2px 0;
}
.dm_badgesStart {
  justify-content: flex-start;
}
.dm_status {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dm_statusOk {
  color: var(--dsw-alias-state-success-primary);
}

/* ── memory data manager ─────────────────────────────────────────────────
   One overlay covers the whole settings shell. It is deliberately fixed to
   the viewport instead of portaled: the client runtime exposes React only
   (no react-dom), and every ancestor in the settings panel is transform-free,
   so a fixed position stays viewport-relative. */
.dm_dataSummary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dm_dataSummaryItem {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dm_modalBackdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, #000 38%, transparent);
}
.dm_modal {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(920px, 96vw);
  max-height: min(88vh, 840px);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.36);
  overflow: hidden;
}
.dm_modalHead {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  flex: 0 0 auto;
}
.dm_modalTitleWrap {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}
.dm_modalTitle {
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
  margin: 0;
}
.dm_modalSub {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dm_iconBtn {
  box-sizing: border-box;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 16px;
  line-height: 24px;
  cursor: pointer;
}
.dm_iconBtn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent));
}
.dm_iconBtn:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dm_modalToolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 10px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  flex: 0 0 auto;
}
.dm_searchWrap {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 220px;
  min-width: 180px;
}
.dm_search {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}
.dm_search::placeholder {
  color: var(--dsw-alias-label-tertiary);
}
.dm_search:focus-visible,
.dm_textarea:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dm_filter {
  box-sizing: border-box;
  max-width: 150px;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 20px;
}
.dm_filter option {
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
}
.dm_filterCheck {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dm_filterCheck input {
  margin: 0;
}
.dm_modalAlert {
  padding: 8px 16px 0;
  flex: 0 0 auto;
}
.dm_modalBody {
  flex: 1 1 auto;
  min-height: 120px;
  overflow: auto;
  overscroll-behavior: contain;
}
.dm_modalBodyList {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dm_dataScroll {
  flex: 1 1 auto;
  min-height: 120px;
  overflow: auto;
  overscroll-behavior: contain;
}
.dm_dataList {
  display: flex;
  flex-direction: column;
}
.dm_dataRow {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dm_dataRow:last-child {
  border-bottom: 0;
}
.dm_dataRow:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent);
}
.dm_dataRowMain {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 auto;
  min-width: 0;
}
.dm_dataRowTop {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.dm_dataTitle {
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.dm_kindBadge {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  min-height: 18px;
  padding: 0 6px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  color: var(--dsw-alias-state-business-primary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.dm_badgePinned {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}
.dm_badgeSuperseded {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.dm_dataText {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dm_dataTextOpen {
  display: block;
  overflow: visible;
}
.dm_dataTextToggle {
  align-self: flex-start;
}
.dm_dataMeta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dm_metaTag {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
}
.dm_dataRowActions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 0 0 auto;
}
.dm_dataEmpty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 40px 16px;
  text-align: center;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dm_dataEmptyTitle {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}
.dm_modalFoot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 16px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  flex: 0 0 auto;
}
.dm_modalFootSpacer {
  flex: 1 1 auto;
}
.dm_form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
}
.dm_formField {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dm_formLabel {
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.dm_formHint {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dm_textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 120px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  resize: vertical;
}
.dm_formGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 10px;
}
.dm_formGrid .dm_input,
.dm_formGrid .dm_select {
  box-sizing: border-box;
  width: 100%;
  max-width: none;
  padding: 4px 8px;
}
.dm_checkRow {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.dm_checkRow input {
  margin: 3px 0 0;
}
.dm_formActions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.dm_formActionsSpacer {
  flex: 1 1 auto;
}
.dm_formAlert {
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dm_history {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dm_historyTitle {
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.dm_historyRow {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dm_historyVersion {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
.dm_historyText {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 48px;
  overflow: hidden;
}
.dm_historyTime {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
/* Dark palette: native widgets need an explicit scheme, otherwise the number
   spinners and the select popup paint dark-on-dark. The switch thumb turns
   white so an off switch stays brighter than its track. */
body[data-ds-dark-theme] .dm_input,
body[data-ds-dark-theme] .dm_select,
body[data-ds-dark-theme] .dm_search,
body[data-ds-dark-theme] .dm_filter,
body[data-ds-dark-theme] .dm_textarea {
  color-scheme: dark;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}
body[data-ds-dark-theme] .dm_input::placeholder,
body[data-ds-dark-theme] .dm_search::placeholder,
body[data-ds-dark-theme] .dm_textarea::placeholder {
  color: var(--dsw-alias-label-tertiary);
}
body[data-ds-dark-theme] .dm_select option,
body[data-ds-dark-theme] .dm_filter option {
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
}
body[data-ds-dark-theme] .dm_switchThumb {
  background: #fff;
}
body[data-ds-dark-theme] .dm_switch[data-on="true"] .dm_switchThumb {
  background: #fff;
}
body[data-ds-dark-theme] .dm_key,
body[data-ds-dark-theme] .dm_stat {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
}
`

    /**
     * Insert the page's one stylesheet. A guarded DOM insert (rather than a
     * `<style>` element in the React tree) keeps the tag alive across settings
     * navigation and makes an HMR reload of this module a no-op. `data-plugin`
     * carries this package's name so the client module system can inventory
     * the tag with the bundle that owns it.
     */
    function installStyle() {
      if (typeof document === 'undefined' || document === null) return
      try {
        if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-memory-layered'
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch {
        /* a page without a writable <head> still renders, just unstyled */
      }
    }

    // ── text helpers ─────────────────────────────────────────────────────────

    /**
     * Translate one key and fall back when the dictionary has no entry for it.
     * The locale service answers with the key itself when a lookup misses, so
     * a missing field label degrades to the field key instead of an empty row.
     *
     * @param {(key: string) => string} t
     * @param {string} key
     * @param {string} fallback
     * @returns {string}
     */
    function translate(t, key, fallback) {
      let value
      try {
        value = t(key)
      } catch {
        value = undefined
      }
      if (typeof value !== 'string' || value === '' || value === key) return fallback
      return value
    }

    /**
     * Replace `{name}` placeholders. The page formats its own counts (the
     * locale service is not guaranteed to interpolate), so this stays local.
     *
     * @param {string} template
     * @param {Record<string, string|number>} values
     * @returns {string}
     */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
      )
    }

    // ── host transport ──────────────────────────────────────────────────────

    /**
     * Resolve one host route against the page's own base. Leading slashes are
     * stripped so a GUI mounted under a reverse-proxy prefix keeps the request
     * under that prefix (same rule as `dsh-git-branch`).
     *
     * @param {string} path
     * @returns {string}
     */
    function resolveUrl(path) {
      const relative = String(path).replace(/^\/+/, '')
      try {
        const base = new URL(document.baseURI)
        base.search = ''
        base.hash = ''
        if (!base.pathname.endsWith('/')) base.pathname += '/'
        return new URL(relative, base.href).toString()
      } catch {
        return '/' + relative
      }
    }

    /**
     * One JSON call to the host half. Never throws: every failure comes back as
     * `{ ok: false, error: { code, message } }` so the page can print the code
     * and the message instead of blanking out.
     *
     * @param {string} method - state | save | reset | reveal
     * @param {Record<string, unknown>} payload
     * @param {(key: string) => string} t
     * @returns {Promise<{ ok: boolean, value?: any, error?: { code: string, message: string } }>}
     */
    async function callHost(method, payload, t) {
      const fallbackMessage = translate(t, 'requestFailed', 'request failed')
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          : undefined
      let response
      try {
        response = await fetch(resolveUrl(API_PREFIX + '/' + method), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload === undefined ? {} : payload),
          signal,
        })
      } catch (error) {
        const message = error instanceof Error && error.message !== '' ? error.message : translate(t, 'networkError', 'network error')
        return { ok: false, error: { code: 'network', message } }
      }
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (body !== null && typeof body === 'object' && body.ok === true) {
        return { ok: true, value: body.value }
      }
      const error = body !== null && typeof body === 'object' ? body.error : undefined
      const code = error !== undefined && error !== null && typeof error.code === 'string' ? error.code : 'http-' + response.status
      const message =
        error !== undefined && error !== null && typeof error.message === 'string' && error.message !== ''
          ? error.message
          : fallbackMessage + ' (HTTP ' + response.status + ')'
      return { ok: false, error: { code, message } }
    }

    /**
     * Coerce one `state` answer into the shape the page renders. A missing or
     * malformed payload yields `null`, which the page turns into an error bar
     * rather than a half-drawn UI.
     *
     * @param {unknown} value
     * @returns {any|null}
     */
    function normalizeState(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      const groups = Array.isArray(value.groups)
        ? value.groups.filter(group => group !== null && typeof group === 'object' && Array.isArray(group.fields))
        : []
      return Object.assign({}, value, { groups })
    }

    // ── formatting / value helpers ──────────────────────────────────────────

    /** Structural equality with numeric tolerance (JSON values only). */
    function sameValue(left, right) {
      if (left === right) return true
      if (typeof left === 'number' && typeof right === 'number') return Math.abs(left - right) < 1e-9
      if (left === null || left === undefined || right === null || right === undefined) return false
      return JSON.stringify(left) === JSON.stringify(right)
    }

    /** Human-readable byte count (B/KB/MB/GB) with an em dash fallback. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
      if (bytes < 1024) return String(Math.round(bytes)) + ' B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let value = bytes / 1024
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return (value >= 100 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[index]
    }

    /** Two-digit zero padding without Intl (stable across browsers). */
    function pad2(value) {
      return value < 10 ? '0' + value : String(value)
    }

    /** Local `YYYY-MM-DD HH:mm` for a millisecond timestamp. */
    function formatTime(milliseconds) {
      if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds <= 0) return '—'
      const date = new Date(milliseconds)
      if (Number.isNaN(date.getTime())) return '—'
      return (
        date.getFullYear() +
        '-' +
        pad2(date.getMonth() + 1) +
        '-' +
        pad2(date.getDate()) +
        ' ' +
        pad2(date.getHours()) +
        ':' +
        pad2(date.getMinutes())
      )
    }

    /** Grouped integer for the statistics tiles. */
    function formatCount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      try {
        return value.toLocaleString()
      } catch {
        return String(value)
      }
    }

    /** An enum option may arrive as a bare string (host catalog) or an object. */
    function optionValue(option) {
      if (typeof option === 'string') return option
      if (option !== null && typeof option === 'object' && typeof option.value === 'string') return option.value
      return ''
    }

    /**
     * Copy one string. The clipboard API is the fast path; the textarea trick
     * keeps the button useful on an insecure origin where `navigator.clipboard`
     * is absent.
     *
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* fall through to the selection trick */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const copied = document.execCommand('copy')
        document.body.removeChild(area)
        return copied !== false
      } catch {
        return false
      }
    }

    // ── tiny inline icons (no image requests, no icon font) ─────────────────

    function RefreshIcon() {
      return h(
        'svg',
        {
          width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
          style: { flex: '0 0 auto' },
        },
        h('path', { d: 'M13 8a5 5 0 1 1-1.5-3.5' }),
        h('path', { d: 'M13 2.5V5h-2.5' }),
      )
    }

    function CopyIcon() {
      return h(
        'svg',
        {
          width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
          style: { flex: '0 0 auto' },
        },
        h('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }),
        h('path', { d: 'M10.5 3.5h-6a1 1 0 0 0-1 1v6' }),
      )
    }

    function FolderIcon() {
      return h(
        'svg',
        {
          width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
          style: { flex: '0 0 auto' },
        },
        h('path', { d: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.3 1.5h5.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z' }),
      )
    }

    // ── hooks ───────────────────────────────────────────────────────────────

    /**
     * Re-render when the active locale changes. The bound translate function
     * reads the active locale at call time, so one render pass is enough.
     *
     * @param {any} locale
     */
    function useLocaleRefresh(locale) {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        if (locale === null || typeof locale !== 'object' || typeof locale.subscribe !== 'function') return undefined
        let disposed = false
        const off = locale.subscribe(() => {
          if (!disposed) bump(version => version + 1)
        })
        return () => {
          disposed = true
          if (typeof off === 'function') off()
        }
      }, [locale])
    }

    /**
     * Register the zh/en dictionaries. The object form is the documented shape
     * for built-in locales; the per-locale form is the fallback so an older
     * locale service still localizes the page. Returns a disposer for
     * `ctx.effect`.
     *
     * @param {any} locale
     * @returns {() => void}
     */
    function registerDictionaries(locale) {
      if (locale === null || typeof locale !== 'object' || typeof locale.register !== 'function') return () => {}
      try {
        const off = locale.register(NS, { zh, en })
        return typeof off === 'function' ? off : () => {}
      } catch {
        const disposers = []
        for (const entry of [['zh', zh], ['en', en]]) {
          try {
            const off = locale.register(NS, entry[0], entry[1])
            if (typeof off === 'function') disposers.push(off)
          } catch {
            /* a language that refuses to register must not break the page */
          }
        }
        return () => {
          for (const off of disposers) off()
        }
      }
    }

    /**
     * The 记忆数据 window: a viewport-level overlay over Settings → Memory that
     * lists the rows of the `memory` table, searches them, and creates, edits or
     * deletes one.
     *
     * It owns its own request lifecycle — the section only toggles visibility, so
     * opening the window re-reads the host instead of trusting a stale list:
     *
     *   memories        → one filtered page (+ facets for the dropdowns)
     *   memory          → the fresh row and its version history before an edit
     *   memoryCreate    → new row (identical text is merged into the existing row)
     *   memoryUpdate    → rewrite (text changes bump the version and keep history)
     *   memoryDelete    → one row
     *
     * Every write calls `onChanged`, so the section can refresh the statistics
     * card. Reloads keep the current filters and page.
     *
     * @param {{ t: (key: string) => string, tr: (key: string, fallback: string) => string }} options
     * @returns {(props: { onClose: () => void, onChanged: () => void }) => any}
     */
    function createDataBrowser(options) {
      const { t, tr } = options
      /** Must match `PAGE_SIZE` in src/data.js closely enough to keep pages small. */
      const PAGE_SIZE = 20
      /** Mirrors `MAX_TEXT_CHARS` in src/data.js; the host re-validates anyway. */
      const MAX_TEXT = 20_000
      /** Mirrors `KINDS` in src/store.js, in the order the form lists them. */
      const KINDS = [
        'persona',
        'instruction',
        'work_fact',
        'work_method',
        'work_task',
        'work_artifact',
        'episodic',
        'fact',
        'episode',
        'note',
      ]

      const kindLabel = kind => tr('kind.' + kind, kind)
      const scopeLabel = scope => (scope === 'project' ? tr('dataScopeProject', 'Project') : tr('dataScopeGlobal', 'Global'))
      const sourceLabel = source => tr('source.' + source, source)

      /** Trim and split a comma-separated tag string; empty entries disappear. */
      const splitTags = value => {
        const raw = value === null || value === undefined ? '' : String(value)
        const tags = []
        for (const part of raw.split(/[,，]/)) {
          const tag = part.trim()
          if (tag !== '' && tags.indexOf(tag) === -1) tags.push(tag)
        }
        return tags
      }

      /** Shorten free text for a row title fallback. */
      const shorten = (value, max) => {
        const text = String(value === null || value === undefined ? '' : value)
        return text.length > max ? text.slice(0, max) + '…' : text
      }

      /** One memory row → the editable draft the form renders. */
      const draftFromItem = item => ({
        id: item.id,
        text: String(item.text === null || item.text === undefined ? '' : item.text),
        title: String(item.title === null || item.title === undefined ? '' : item.title),
        kind: typeof item.kind === 'string' ? item.kind : 'work_fact',
        scope: item.scope === 'project' ? 'project' : 'global',
        project: item.project === null || item.project === undefined ? '' : String(item.project),
        tags: Array.isArray(item.tags) ? item.tags.join(', ') : '',
        priority: typeof item.priority === 'number' ? item.priority : 50,
        pinned: item.pinned === true,
      })

      return function MemoryDataBrowser(props) {
        const onClose = typeof props?.onClose === 'function' ? props.onClose : () => {}
        const onChanged = typeof props?.onChanged === 'function' ? props.onChanged : null

        const [list, setList] = React.useState(null)
        const [loading, setLoading] = React.useState(false)
        const [error, setError] = React.useState(null)
        const [notice, setNotice] = React.useState('')
        const [searchInput, setSearchInput] = React.useState('')
        const [query, setQuery] = React.useState('')
        const [kind, setKind] = React.useState('')
        const [scope, setScope] = React.useState('')
        const [project, setProject] = React.useState('')
        const [includeSuperseded, setIncludeSuperseded] = React.useState(false)
        const [page, setPage] = React.useState(1)
        const [expanded, setExpanded] = React.useState(0)
        const [view, setView] = React.useState('list')
        const [draft, setDraft] = React.useState(null)
        const [history, setHistory] = React.useState([])
        const [formError, setFormError] = React.useState('')
        const [saving, setSaving] = React.useState(false)
        const [busyId, setBusyId] = React.useState(0)
        const aliveRef = React.useRef(true)

        React.useEffect(() => {
          aliveRef.current = true
          return () => {
            aliveRef.current = false
          }
        }, [])

        /** One host call bound to this page's translate function. */
        const request = (method, payload) => callHost(method, payload, t)

        const errorText = failure =>
          failure !== null && failure !== undefined && typeof failure.message === 'string' && failure.message !== ''
            ? failure.message
            : tr('requestFailed', 'Request failed')

        /**
         * Read one page. `overrides` lets a filter change ask for its own value
         * in the same call (the state setter has not re-rendered yet).
         */
        const fetchPage = (nextPage, overrides) => {
          const patch = overrides !== undefined && overrides !== null ? overrides : {}
          const payload = {
            page: typeof nextPage === 'number' && nextPage > 0 ? nextPage : 1,
            pageSize: PAGE_SIZE,
            sort: 'updated',
            query: patch.query !== undefined ? patch.query : query,
            kind: patch.kind !== undefined ? patch.kind : kind,
            scope: patch.scope !== undefined ? patch.scope : scope,
            project: patch.project !== undefined ? patch.project : project,
            includeSuperseded: patch.includeSuperseded !== undefined ? patch.includeSuperseded : includeSuperseded,
          }
          setLoading(true)
          setError(null)
          return request('memories', payload).then(result => {
            if (!aliveRef.current) return
            setLoading(false)
            if (result.ok !== true) {
              setError(result.error)
              return
            }
            const value = result.value
            if (value === null || typeof value !== 'object' || !Array.isArray(value.items)) {
              setError({ code: 'internal', message: tr('requestFailed', 'Request failed') })
              return
            }
            setList(value)
            if (typeof value.page === 'number' && value.page > 0) setPage(value.page)
          })
        }

        // First paint: one unfiltered page. Later loads are explicit (filter
        // change, pager, refresh, or after a write) so no effect races them.
        React.useEffect(() => {
          fetchPage(1)
        }, [])

        // Escape closes the window, like the settings shell's own dialogs.
        React.useEffect(() => {
          if (typeof document === 'undefined' || document === null || typeof document.addEventListener !== 'function') {
            return undefined
          }
          const onKey = event => {
            if (event !== null && event !== undefined && event.key === 'Escape') onClose()
          }
          document.addEventListener('keydown', onKey)
          return () => {
            try {
              document.removeEventListener('keydown', onKey)
            } catch {
              /* a detached document cannot remove the listener; harmless */
            }
          }
        }, [onClose])

        // ── filter actions ─────────────────────────────────────────────────

        const submitSearch = () => {
          if (loading) return
          const next = searchInput.trim()
          setQuery(next)
          fetchPage(1, { query: next })
        }

        const clearSearch = () => {
          if (loading) return
          setSearchInput('')
          setQuery('')
          fetchPage(1, { query: '' })
        }

        const changeKind = value => {
          setKind(value)
          fetchPage(1, { kind: value })
        }

        const changeScope = value => {
          setScope(value)
          fetchPage(1, { scope: value })
        }

        const changeProject = value => {
          setProject(value)
          fetchPage(1, { project: value })
        }

        const changeIncludeSuperseded = value => {
          setIncludeSuperseded(value)
          fetchPage(1, { includeSuperseded: value })
        }

        // ── write actions ──────────────────────────────────────────────────

        const startCreate = () => {
          setNotice('')
          setError(null)
          setFormError('')
          setHistory([])
          setDraft({
            id: null,
            text: '',
            title: '',
            kind: 'work_fact',
            scope: 'global',
            project: '',
            tags: '',
            priority: 50,
            pinned: false,
          })
          setView('form')
        }

        const startEdit = item => {
          if (item === null || typeof item !== 'object') return
          setNotice('')
          setError(null)
          setFormError('')
          setHistory([])
          setDraft(draftFromItem(item))
          setView('form')
          // Re-read the row: the list can be a page old, and only this endpoint
          // returns the version history the form shows.
          request('memory', { id: item.id }).then(result => {
            if (!aliveRef.current || result.ok !== true) return
            const value = result.value
            if (value === null || typeof value !== 'object') return
            if (value.item !== null && typeof value.item === 'object') setDraft(draftFromItem(value.item))
            if (Array.isArray(value.history)) setHistory(value.history)
          })
        }

        const updateDraft = patch => {
          setDraft(previous => (previous === null ? previous : Object.assign({}, previous, patch)))
        }

        const saveDraft = () => {
          if (saving || draft === null) return
          const text = String(draft.text === null || draft.text === undefined ? '' : draft.text)
          if (text.trim() === '') {
            setFormError(tr('dataRequired', 'Body is required'))
            return
          }
          if (text.length > MAX_TEXT) {
            setFormError(fill(tr('dataTooLong', 'Body may have at most {n} characters'), { n: MAX_TEXT }))
            return
          }
          if (draft.scope === 'project' && String(draft.project).trim() === '') {
            setFormError(tr('dataProjectRequired', 'Project scope needs a project name'))
            return
          }
          const editing = draft.id !== null
          const payload = {
            text: text.trim(),
            title: String(draft.title === null || draft.title === undefined ? '' : draft.title).trim(),
            kind: draft.kind,
            scope: draft.scope,
            project: String(draft.project === null || draft.project === undefined ? '' : draft.project).trim(),
            tags: splitTags(draft.tags),
            priority: Number.isFinite(Number(draft.priority)) ? Number(draft.priority) : 50,
            pinned: draft.pinned === true,
          }
          if (editing) payload.id = draft.id
          setSaving(true)
          setFormError('')
          request(editing ? 'memoryUpdate' : 'memoryCreate', payload).then(result => {
            if (!aliveRef.current) return
            setSaving(false)
            if (result.ok !== true) {
              setFormError(errorText(result.error))
              return
            }
            const value = result.value !== null && typeof result.value === 'object' ? result.value : {}
            const item = value.item !== null && typeof value.item === 'object' ? value.item : null
            const id = item !== null ? item.id : draft.id
            const merged = editing !== true && value.inserted === false
            setView('list')
            setNotice(
              editing === true
                ? fill(tr('dataUpdated', 'Saved #{id}'), { id })
                : merged
                  ? fill(tr('dataMerged', 'That text already existed; updated #{id}'), { id })
                  : fill(tr('dataCreated', 'Created memory #{id}'), { id }),
            )
            if (onChanged !== null) onChanged()
            fetchPage(editing === true ? page : 1)
          })
        }

        const backToList = () => {
          if (saving) return
          setView('list')
          setFormError('')
          setDraft(null)
          setHistory([])
        }

        const remove = item => {
          if (saving || busyId !== 0) return
          const question = fill(tr('dataConfirmDelete', 'Delete memory #{id}? This cannot be undone.'), { id: item.id })
          if (
            typeof window !== 'undefined' &&
            typeof window.confirm === 'function' &&
            window.confirm(question) !== true
          ) {
            return
          }
          setBusyId(item.id)
          setError(null)
          setNotice('')
          request('memoryDelete', { id: item.id }).then(result => {
            if (!aliveRef.current) return
            setBusyId(0)
            if (result.ok !== true) {
              setError(result.error)
              return
            }
            setNotice(fill(tr('dataDeleted', 'Deleted #{id}'), { id: item.id }))
            if (onChanged !== null) onChanged()
            // Removing the only row of the last page steps back one page.
            const items = list !== null && Array.isArray(list.items) ? list.items : []
            fetchPage(items.length === 1 && page > 1 ? page - 1 : page)
          })
        }

        // ── projections ────────────────────────────────────────────────────

        const items = list !== null && Array.isArray(list.items) ? list.items : []
        const facets = list !== null && list.facets !== null && typeof list.facets === 'object' ? list.facets : {}
        const kindFacets = Array.isArray(facets.kinds) ? facets.kinds : []
        const projectFacets = Array.isArray(facets.projects) ? facets.projects : []
        const total = list !== null && typeof list.total === 'number' ? list.total : 0
        const storedTotal = typeof facets.total === 'number' ? facets.total : total
        const pages = list !== null && typeof list.pages === 'number' && list.pages > 0 ? list.pages : 1
        const currentPage = list !== null && typeof list.page === 'number' && list.page > 0 ? list.page : page
        const filtered = query !== '' || kind !== '' || scope !== '' || project !== ''
        const totalText = fill(tr('dataTotal', '{n} entries'), { n: formatCount(storedTotal) })
        const resultText = filtered
          ? fill(tr('dataMatched', '{n} matching'), { n: formatCount(total) })
          : fill(tr('dataShown', 'Showing {n}'), { n: formatCount(items.length) })

        // ── list rendering ─────────────────────────────────────────────────

        const renderRow = item => {
          const isOpen = expanded === item.id
          const text = String(item.text === null || item.text === undefined ? '' : item.text)
          // A derived title is the first sentence of the body; showing both
          // verbatim doubles every short row, so the preview starts after the
          // title (and disappears when the body carries nothing else).
          const explicitTitle = item.title !== '' && item.title !== null && item.title !== undefined
          const titleText = explicitTitle ? String(item.title) : shorten(text, 80)
          let bodyText = text
          if (explicitTitle && text.indexOf(titleText) === 0) {
            bodyText = text
              .slice(titleText.length)
              .trim()
              // A derived title cuts at a sentence boundary; the body then starts
              // with that boundary's punctuation, which reads as noise on its own.
              .replace(/^[：:，,。.；;、\s]+/, '')
          } else if (!explicitTitle && text.length <= 80) bodyText = ''
          const long = bodyText.length > 180 || bodyText.indexOf('\n') !== -1
          const tags = Array.isArray(item.tags) ? item.tags : []
          return h(
            'div',
            { className: 'dm_dataRow', key: 'memory-' + item.id },
            h(
              'div',
              { className: 'dm_dataRowMain' },
              h(
                'div',
                { className: 'dm_dataRowTop' },
                h('span', { className: 'dm_kindBadge' }, kindLabel(item.kind)),
                h(
                  'span',
                  { className: 'dm_badge' },
                  scopeLabel(item.scope) + (item.project !== null && item.project !== undefined ? ' · ' + item.project : ''),
                ),
                item.pinned === true ? h('span', { className: 'dm_badge dm_badgePinned' }, tr('dataPinnedBadge', 'Pinned')) : null,
                item.supersededBy !== null && item.supersededBy !== undefined
                  ? h('span', { className: 'dm_badge dm_badgeSuperseded' }, tr('dataSupersededBadge', 'Superseded'))
                  : null,
                h(
                  'span',
                  { className: 'dm_dataTitle', title: text },
                  titleText,
                ),
              ),
              bodyText !== ''
                ? h('div', { className: isOpen ? 'dm_dataText dm_dataTextOpen' : 'dm_dataText' }, bodyText)
                : null,
              long
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dm_linkBtn dm_dataTextToggle',
                      onClick: () => setExpanded(isOpen ? 0 : item.id),
                    },
                    isOpen ? tr('dataCollapse', 'Collapse') : tr('dataExpand', 'Expand'),
                  )
                : null,
              h(
                'div',
                { className: 'dm_dataMeta' },
                h('span', null, '#' + item.id),
                h('span', null, fill(tr('dataUpdatedAt', 'Updated {time}'), { time: formatTime(item.updatedAt) })),
                h('span', null, fill(tr('dataUseCount', 'Used {n} times'), { n: formatCount(item.useCount) })),
                h('span', null, fill(tr('dataPriorityShort', 'Priority {n}'), { n: item.priority })),
                h('span', null, tr('dataSource', 'Source') + ' ' + sourceLabel(item.source)),
                item.version > 1 ? h('span', null, fill(tr('dataVersion', 'Version {v}'), { v: item.version })) : null,
                tags.map(tag => h('span', { className: 'dm_metaTag', key: 'tag-' + item.id + '-' + tag }, tag)),
              ),
            ),
            h(
              'div',
              { className: 'dm_dataRowActions' },
              h(
                'button',
                { type: 'button', className: 'dm_btn', onClick: () => startEdit(item), disabled: saving },
                tr('dataEdit', 'Edit'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dm_btn dm_btnDanger',
                  onClick: () => remove(item),
                  disabled: saving || busyId === item.id,
                },
                tr('dataDelete', 'Delete'),
              ),
            ),
          )
        }

        const renderList = () =>
          items.length === 0
            ? h(
                'div',
                { className: 'dm_dataEmpty' },
                h('div', { className: 'dm_dataEmptyTitle' }, loading ? tr('dataLoading', 'Loading…') : tr('dataEmpty', 'No matching memories')),
                loading ? null : h('div', null, tr('dataEmptyHint', '')),
              )
            : h('div', { className: 'dm_dataList' }, items.map(renderRow))

        const renderToolbar = () => {
          const projectOptions = projectFacets.map(entry => entry.project)
          return h(
            'div',
            { className: 'dm_modalToolbar' },
            h(
              'div',
              { className: 'dm_searchWrap' },
              h('input', {
                type: 'search',
                className: 'dm_search',
                value: searchInput,
                placeholder: tr('dataSearchPlaceholder', 'Search…'),
                'aria-label': tr('dataSearchPlaceholder', 'Search…'),
                autoFocus: true,
                disabled: loading,
                onChange: event => setSearchInput(event.target.value),
                onKeyDown: event => {
                  if (event.key === 'Enter') submitSearch()
                },
              }),
              h(
                'button',
                { type: 'button', className: 'dm_btn dm_btnPrimary', onClick: submitSearch, disabled: loading },
                tr('dataSearch', 'Search'),
              ),
              query !== ''
                ? h(
                    'button',
                    { type: 'button', className: 'dm_btn', onClick: clearSearch, disabled: loading, title: tr('dataSearchClear', 'Clear') },
                    '×',
                  )
                : null,
            ),
            h(
              'select',
              {
                className: 'dm_filter',
                value: kind,
                'aria-label': tr('dataFieldKind', 'Kind'),
                disabled: loading,
                onChange: event => changeKind(event.target.value),
              },
              h('option', { value: '' }, tr('dataKindAll', 'All kinds')),
              kindFacets.map(entry =>
                h('option', { key: 'kind-filter-' + entry.kind, value: entry.kind }, kindLabel(entry.kind) + ' (' + entry.count + ')'),
              ),
            ),
            h(
              'select',
              {
                className: 'dm_filter',
                value: scope,
                'aria-label': tr('dataFieldScope', 'Scope'),
                disabled: loading,
                onChange: event => changeScope(event.target.value),
              },
              h('option', { value: '' }, tr('dataScopeAll', 'All scopes')),
              h('option', { value: 'global' }, tr('dataScopeGlobal', 'Global')),
              h('option', { value: 'project' }, tr('dataScopeProject', 'Project')),
            ),
            h(
              'select',
              {
                className: 'dm_filter',
                value: project,
                'aria-label': tr('dataFieldProject', 'Project'),
                disabled: loading,
                onChange: event => changeProject(event.target.value),
              },
              h('option', { value: '' }, tr('dataProjectAll', 'All projects')),
              project !== '' && projectOptions.indexOf(project) === -1 ? h('option', { value: project }, project) : null,
              projectFacets.map(entry =>
                h('option', { key: 'project-filter-' + entry.project, value: entry.project }, entry.project + ' (' + entry.count + ')'),
              ),
            ),
            h(
              'label',
              { className: 'dm_filterCheck' },
              h('input', {
                type: 'checkbox',
                checked: includeSuperseded,
                disabled: loading,
                onChange: event => changeIncludeSuperseded(event.target.checked),
              }),
              tr('dataIncludeSuperseded', 'Include superseded'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dm_btn',
                onClick: () => fetchPage(currentPage),
                disabled: loading,
                title: tr('dataRefresh', 'Refresh'),
              },
              RefreshIcon(),
              tr('dataRefresh', 'Refresh'),
            ),
            h(
              'button',
              { type: 'button', className: 'dm_btn dm_btnPrimary', onClick: startCreate, disabled: loading || saving },
              '+ ' + tr('dataNew', 'New memory'),
            ),
          )
        }

        const renderFooter = () =>
          h(
            'div',
            { className: 'dm_modalFoot' },
            h('span', null, resultText),
            h('span', { className: 'dm_modalFootSpacer' }),
            h('span', null, fill(tr('dataPageOf', 'Page {page} / {pages}'), { page: currentPage, pages })),
            h(
              'button',
              { type: 'button', className: 'dm_btn', onClick: () => fetchPage(currentPage - 1), disabled: loading || currentPage <= 1 },
              tr('dataPrev', 'Previous'),
            ),
            h(
              'button',
              { type: 'button', className: 'dm_btn', onClick: () => fetchPage(currentPage + 1), disabled: loading || currentPage >= pages },
              tr('dataNext', 'Next'),
            ),
          )

        // ── form rendering ─────────────────────────────────────────────────

        const renderForm = () => {
          if (draft === null) return null
          const editing = draft.id !== null
          const historyRows = history.slice(0, 6)
          return h(
            'div',
            { className: 'dm_form' },
            formError !== '' ? h('div', { className: 'dm_formAlert', role: 'alert' }, formError) : null,
            h(
              'div',
              { className: 'dm_formField' },
              h('label', { className: 'dm_formLabel' }, tr('dataFieldText', 'Body')),
              h('textarea', {
                className: 'dm_textarea',
                value: draft.text,
                rows: 6,
                'aria-label': tr('dataFieldText', 'Body'),
                disabled: saving,
                onChange: event => updateDraft({ text: event.target.value }),
              }),
              h('div', { className: 'dm_formHint' }, tr('dataFieldTextHint', '')),
            ),
            h(
              'div',
              { className: 'dm_formField' },
              h('label', { className: 'dm_formLabel' }, tr('dataFieldTitle', 'Title')),
              h('input', {
                type: 'text',
                className: 'dm_input dm_inputWide',
                value: draft.title,
                placeholder: tr('dataFieldTitlePlaceholder', ''),
                'aria-label': tr('dataFieldTitle', 'Title'),
                disabled: saving,
                onChange: event => updateDraft({ title: event.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'dm_formGrid' },
              h(
                'div',
                { className: 'dm_formField' },
                h('label', { className: 'dm_formLabel' }, tr('dataFieldKind', 'Kind')),
                h(
                  'select',
                  {
                    className: 'dm_select',
                    value: draft.kind,
                    'aria-label': tr('dataFieldKind', 'Kind'),
                    disabled: saving,
                    onChange: event => updateDraft({ kind: event.target.value }),
                  },
                  KINDS.map(item => h('option', { key: 'form-kind-' + item, value: item }, kindLabel(item))),
                ),
              ),
              h(
                'div',
                { className: 'dm_formField' },
                h('label', { className: 'dm_formLabel' }, tr('dataFieldScope', 'Scope')),
                h(
                  'select',
                  {
                    className: 'dm_select',
                    value: draft.scope,
                    'aria-label': tr('dataFieldScope', 'Scope'),
                    disabled: saving,
                    onChange: event => updateDraft({ scope: event.target.value }),
                  },
                  h('option', { value: 'global' }, tr('dataScopeGlobal', 'Global')),
                  h('option', { value: 'project' }, tr('dataScopeProject', 'Project')),
                ),
              ),
              draft.scope === 'project'
                ? h(
                    'div',
                    { className: 'dm_formField' },
                    h('label', { className: 'dm_formLabel' }, tr('dataFieldProject', 'Project')),
                    h('input', {
                      type: 'text',
                      className: 'dm_input',
                      value: draft.project,
                      placeholder: tr('dataFieldProjectPlaceholder', ''),
                      'aria-label': tr('dataFieldProject', 'Project'),
                      disabled: saving,
                      onChange: event => updateDraft({ project: event.target.value }),
                    }),
                  )
                : null,
              h(
                'div',
                { className: 'dm_formField' },
                h('label', { className: 'dm_formLabel' }, tr('dataFieldPriority', 'Priority')),
                h('input', {
                  type: 'number',
                  inputMode: 'numeric',
                  className: 'dm_input',
                  min: 0,
                  max: 100,
                  step: 1,
                  value: String(draft.priority),
                  'aria-label': tr('dataFieldPriority', 'Priority'),
                  disabled: saving,
                  onChange: event => updateDraft({ priority: event.target.value }),
                }),
                h('div', { className: 'dm_formHint' }, tr('dataFieldPriorityHint', '')),
              ),
              h(
                'div',
                { className: 'dm_formField' },
                h('label', { className: 'dm_formLabel' }, tr('dataFieldTags', 'Tags')),
                h('input', {
                  type: 'text',
                  className: 'dm_input dm_inputWide',
                  value: draft.tags,
                  placeholder: tr('dataFieldTagsPlaceholder', ''),
                  'aria-label': tr('dataFieldTags', 'Tags'),
                  disabled: saving,
                  onChange: event => updateDraft({ tags: event.target.value }),
                }),
              ),
            ),
            h(
              'div',
              { className: 'dm_checkRow' },
              h('input', {
                type: 'checkbox',
                id: 'dm-data-pinned',
                checked: draft.pinned,
                disabled: saving,
                onChange: event => updateDraft({ pinned: event.target.checked }),
              }),
              h(
                'label',
                { htmlFor: 'dm-data-pinned' },
                h('div', { className: 'dm_formLabel' }, tr('dataFieldPinned', 'Always inject')),
                h('div', { className: 'dm_formHint' }, tr('dataFieldPinnedHint', '')),
              ),
            ),
            editing
              ? h(
                  'div',
                  { className: 'dm_history' },
                  h(
                    'div',
                    { className: 'dm_historyTitle' },
                    fill(tr('dataHistoryTitle', 'Earlier versions ({n})'), { n: history.length }),
                  ),
                  historyRows.length === 0
                    ? h('div', { className: 'dm_formHint' }, tr('dataHistoryEmpty', 'No earlier versions'))
                    : historyRows.map((row, index) =>
                        h(
                          'div',
                          { className: 'dm_historyRow', key: 'history-' + index },
                          h(
                            'span',
                            { className: 'dm_historyVersion' },
                            fill(tr('dataVersion', 'Version {v}'), { v: row.version }),
                          ),
                          h('span', { className: 'dm_historyText' }, String(row.text === null || row.text === undefined ? '' : row.text)),
                          h('span', { className: 'dm_historyTime' }, formatTime(row.createdAt)),
                        ),
                      ),
                )
              : null,
            h(
              'div',
              { className: 'dm_formActions' },
              h('button', { type: 'button', className: 'dm_btn', onClick: backToList, disabled: saving }, tr('dataBack', 'Back to list')),
              h('span', { className: 'dm_formActionsSpacer' }),
              h(
                'button',
                { type: 'button', className: 'dm_btn dm_btnPrimary', onClick: saveDraft, disabled: saving },
                saving ? tr('dataSaving', 'Saving…') : tr('dataSave', 'Save'),
              ),
            ),
          )
        }

        // ── window ─────────────────────────────────────────────────────────

        const headText = view === 'form' && draft !== null && draft.id !== null ? fill(tr('dataFormEdit', 'Edit memory #{id}'), { id: draft.id }) : view === 'form' ? tr('dataFormNew', 'New memory') : tr('dataModalTitle', 'Memory data')

        const overlay = h(
          'div',
          {
            className: 'dm_modalBackdrop',
            role: 'presentation',
            onMouseDown: event => {
              if (event.target === event.currentTarget) onClose()
            },
          },
          h(
            'div',
            {
              className: 'dm_modal',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': tr('dataModalTitle', 'Memory data'),
            },
            h(
              'div',
              { className: 'dm_modalHead' },
              h(
                'div',
                { className: 'dm_modalTitleWrap' },
                h('h3', { className: 'dm_modalTitle' }, headText),
                view === 'form' ? null : h('span', { className: 'dm_modalSub' }, totalText),
              ),
              h(
                'button',
                { type: 'button', className: 'dm_iconBtn', 'aria-label': tr('dataClose', 'Close'), title: tr('dataClose', 'Close'), onClick: onClose },
                '×',
              ),
            ),
            view === 'form'
              ? h('div', { className: 'dm_modalBody' }, renderForm())
              : h(
                  'div',
                  { className: 'dm_modalBody dm_modalBodyList' },
                  renderToolbar(),
                  error !== null ? h('div', { className: 'dm_modalAlert' }, renderDataAlert(error)) : null,
                  notice !== '' ? h('div', { className: 'dm_modalAlert' }, h('div', { className: 'dm_status dm_statusOk' }, notice)) : null,
                  h('div', { className: 'dm_dataScroll' }, renderList()),
                  renderFooter(),
                ),
          ),
        )

        // Portal when react-dom is available: the settings shell may sit inside a
        // scrolling or transformed panel, and the window must cover the viewport.
        if (
          createPortal !== null &&
          typeof document !== 'undefined' &&
          document !== null &&
          document.body !== undefined &&
          document.body !== null
        ) {
          return createPortal(overlay, document.body)
        }
        return overlay
      }
    }

    /**
     * Build the Memory section for one client context.
     *
     * @param {any} locale - the locale service (live re-render on locale switch)
     * @param {(key: string) => string} t - translate bound to this namespace
     * @returns {() => any}
     */
    function createSection(locale, t) {
      /** Localize one key with a fallback that never renders an empty row. */
      const tr = (key, fallback) => translate(t, key, fallback)

      /** The data window is built once so its component identity is stable. */
      const MemoryDataBrowser = createDataBrowser({ t, tr })

      return function MemorySection() {
        useLocaleRefresh(locale)

        const [state, setState] = React.useState(null)
        const [edits, setEdits] = React.useState({})
        const [resets, setResets] = React.useState([])
        const [busy, setBusy] = React.useState('')
        const [loadError, setLoadError] = React.useState(null)
        const [actionError, setActionError] = React.useState(null)
        const [notice, setNotice] = React.useState('')
        const [dataOpen, setDataOpen] = React.useState(false)
        const aliveRef = React.useRef(true)

        React.useEffect(() => {
          aliveRef.current = true
          return () => {
            aliveRef.current = false
          }
        }, [])

        /** Read the whole page state from the host. */
        const load = React.useCallback(() => {
          setLoadError(null)
          setBusy(previous => (previous === '' ? 'load' : previous))
          return callHost('state', {}, t).then(result => {
            if (!aliveRef.current) return
            setBusy('')
            if (result.ok !== true) {
              setLoadError(result.error)
              return
            }
            const next = normalizeState(result.value)
            if (next === null) {
              setLoadError({ code: 'internal', message: tr('requestFailed', 'Request failed') })
              return
            }
            setState(next)
          })
        }, [t])

        React.useEffect(() => {
          load()
        }, [load])

        // ── projected data ──────────────────────────────────────────────────

        const groups = state !== null ? state.groups : []
        const fields = []
        for (const group of groups) {
          for (const field of group.fields) {
            if (field !== null && typeof field === 'object' && typeof field.key === 'string') fields.push(field)
          }
        }
        const fieldsByKey = new Map(fields.map(field => [field.key, field]))
        const storage = state !== null && state.storage !== null && typeof state.storage === 'object' ? state.storage : {}
        const stats = state !== null && state.stats !== null && typeof state.stats === 'object' ? state.stats : {}
        const plugin = state !== null && state.plugin !== null && typeof state.plugin === 'object' ? state.plugin : null

        // ── draft bookkeeping ───────────────────────────────────────────────

        const hasEdit = key => Object.prototype.hasOwnProperty.call(edits, key)
        const isReset = key => resets.indexOf(key) !== -1
        const draftOf = field => (hasEdit(field.key) ? edits[field.key] : field.value)

        /** The message shown when a number input cannot be saved. */
        const numberHint = field => {
          if (typeof field.min === 'number' && typeof field.max === 'number') {
            return fill(tr('invalidNumber', 'invalid number'), { min: field.min, max: field.max })
          }
          return tr('invalidNumberOnly', 'invalid number')
        }

        /** Parse (and range-check) a number field's current draft. */
        const parseNumber = field => {
          const raw = hasEdit(field.key) ? edits[field.key] : field.value
          if (raw === '' || raw === null || raw === undefined || typeof raw === 'boolean') {
            return { ok: false, message: numberHint(field) }
          }
          const value = Number(raw)
          if (!Number.isFinite(value)) return { ok: false, message: numberHint(field) }
          if (typeof field.min === 'number' && value < field.min) return { ok: false, message: numberHint(field) }
          if (typeof field.max === 'number' && value > field.max) return { ok: false, message: numberHint(field) }
          return { ok: true, value }
        }

        const fieldDirty = field => {
          if (isReset(field.key)) return true
          if (!hasEdit(field.key)) return false
          if (field.type === 'number') {
            const parsed = parseNumber(field)
            return parsed.ok !== true || !sameValue(parsed.value, field.value)
          }
          return !sameValue(edits[field.key], field.value)
        }
        const dirtyCount = fields.filter(fieldDirty).length

        // ── actions ─────────────────────────────────────────────────────────

        const editField = (key, value) => {
          setEdits(previous => Object.assign({}, previous, { [key]: value }))
          setResets(previous => (previous.indexOf(key) === -1 ? previous : previous.filter(item => item !== key)))
          setActionError(null)
          setNotice('')
        }

        /** Toggle "revert this one field to the YAML/default value". */
        const toggleReset = field => {
          setActionError(null)
          setNotice('')
          if (isReset(field.key)) {
            setResets(previous => previous.filter(item => item !== field.key))
            return
          }
          setEdits(previous => {
            const next = Object.assign({}, previous)
            delete next[field.key]
            return next
          })
          setResets(previous => (previous.indexOf(field.key) === -1 ? previous.concat(field.key) : previous))
        }

        const discard = () => {
          setEdits({})
          setResets([])
          setActionError(null)
          setNotice('')
        }

        const save = () => {
          if (busy !== '') return
          const patch = {}
          const unset = []
          const problems = []
          for (const field of fields) {
            if (!fieldDirty(field)) continue
            if (isReset(field.key)) {
              unset.push(field.key)
              continue
            }
            const raw = edits[field.key]
            if (field.type === 'number') {
              const parsed = parseNumber(field)
              if (parsed.ok !== true) {
                problems.push(field.key + ': ' + numberHint(field))
                continue
              }
              patch[field.key] = parsed.value
            } else if (field.type === 'boolean' || field.type === 'enum') {
              patch[field.key] = raw
            } else {
              patch[field.key] = String(raw === null || raw === undefined ? '' : raw).trim()
            }
          }
          if (problems.length > 0) {
            setActionError({ code: 'bad-request', message: problems.join('; ') })
            return
          }
          setBusy('save')
          setActionError(null)
          setNotice('')
          callHost('save', { patch, unset }, t).then(result => {
            if (!aliveRef.current) return
            setBusy('')
            if (result.ok !== true) {
              setActionError(result.error)
              return
            }
            const value = result.value !== null && typeof result.value === 'object' ? result.value : {}
            const next = normalizeState(value.state)
            if (next !== null) setState(next)
            setEdits({})
            setResets([])
            const restart = Array.isArray(value.restartRequired)
              ? value.restartRequired.filter(key => typeof key === 'string')
              : []
            if (restart.length > 0) setNotice(fill(tr('savedRestart', 'saved'), { n: restart.length }))
            else setNotice(tr('savedLive', 'saved'))
            // A save answer without a state still has to refresh the numbers.
            if (next === null) load()
          })
        }

        const resetBaseline = () => {
          if (busy !== '') return
          if (
            typeof window !== 'undefined' &&
            typeof window.confirm === 'function' &&
            window.confirm(tr('confirmReset', 'Reset every setting?')) !== true
          ) {
            return
          }
          setBusy('reset')
          setActionError(null)
          setNotice('')
          callHost('reset', {}, t).then(result => {
            if (!aliveRef.current) return
            setBusy('')
            if (result.ok !== true) {
              setActionError(result.error)
              return
            }
            const value = result.value !== null && typeof result.value === 'object' ? result.value : {}
            const next = normalizeState(value.state)
            if (next !== null) setState(next)
            setEdits({})
            setResets([])
            setNotice(tr('resetDone', 'reset'))
            if (next === null) load()
          })
        }

        const reveal = () => {
          if (busy !== '') return
          setBusy('reveal')
          setActionError(null)
          setNotice('')
          callHost('reveal', {}, t).then(result => {
            if (!aliveRef.current) return
            setBusy('')
            if (result.ok !== true) {
              setActionError(result.error)
              return
            }
            const opened = result.value !== null && typeof result.value === 'object' && result.value.opened === true
            if (opened) setNotice(tr('revealOpened', 'opened'))
            else setActionError({ code: 'reveal-failed', message: tr('revealFailed', 'could not open') })
          })
        }

        const copyPath = () => {
          const dir = typeof storage.dir === 'string' ? storage.dir : ''
          if (dir === '') return
          copyText(dir).then(copied => {
            if (!aliveRef.current) return
            if (copied) {
              setActionError(null)
              setNotice(tr('copied', 'copied'))
            } else {
              setActionError({ code: 'copy-failed', message: tr('copyFailed', 'copy failed') })
            }
          })
        }

        const refresh = () => {
          if (busy !== '') return
          if (
            dirtyCount > 0 &&
            typeof window !== 'undefined' &&
            typeof window.confirm === 'function' &&
            window.confirm(tr('confirmDiscard', 'Discard unsaved changes?')) !== true
          ) {
            return
          }
          setEdits({})
          setResets([])
          setActionError(null)
          setNotice('')
          load()
        }

        /** Open the row browser; it reads its own page from the host on mount. */
        const openData = () => {
          setActionError(null)
          setNotice('')
          setDataOpen(true)
        }

        const closeData = () => setDataOpen(false)

        // ── render helpers ──────────────────────────────────────────────────

        const renderAlert = (error, withRetry) => {
          const code = error !== null && error !== undefined && typeof error.code === 'string' ? error.code : ''
          const message =
            error !== null && error !== undefined && typeof error.message === 'string'
              ? error.message
              : tr('requestFailed', 'Request failed')
          return h(
            'div',
            { className: 'dm_alert', role: 'alert' },
            h(
              'div',
              { className: 'dm_alertBody' },
              h(
                'div',
                { className: 'dm_alertTitle' },
                h('span', null, tr('errorTitle', 'Request failed')),
                code !== '' ? h('span', { className: 'dm_alertCode' }, code) : null,
              ),
              h('div', { className: 'dm_alertText' }, message),
            ),
            withRetry === true
              ? h('button', { type: 'button', className: 'dm_btn', onClick: load, disabled: busy !== '' }, tr('retry', 'Retry'))
              : null,
          )
        }

        const renderHead = () => {
          const version = plugin !== null && typeof plugin.version === 'string' ? plugin.version : ''
          const dbReady = plugin !== null && plugin.dbReady === true
          return h(
            'div',
            { className: 'dm_head' },
            h(
              'div',
              { className: 'dm_headText' },
              h('h2', { className: 'dm_title' }, tr('title', 'Memory')),
              h('p', { className: 'dm_intro' }, tr('description', '')),
              plugin !== null
                ? h(
                    'div',
                    { className: 'dm_badges dm_badgesStart' },
                    version !== '' ? h('span', { className: 'dm_badge' }, version) : null,
                    h(
                      'span',
                      { className: dbReady ? 'dm_badge dm_badgeOk' : 'dm_badge dm_badgeRestart' },
                      dbReady ? tr('pluginReady', 'ready') : tr('pluginNotReady', 'not ready'),
                    ),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'dm_headSide' },
              h(
                'button',
                { type: 'button', className: 'dm_btn', onClick: refresh, disabled: busy !== '', title: tr('refresh', 'Refresh') },
                RefreshIcon(),
                tr('refresh', 'Refresh'),
              ),
            ),
          )
        }

        const renderSkeleton = () =>
          h(
            'div',
            { className: 'dm_card dm_skeleton' },
            h('div', { className: 'dm_loading' }, tr('loading', 'Loading…')),
            h('div', { className: 'dm_skBar dm_skBarMid' }),
            h('div', { className: 'dm_skBar dm_skBarShort' }),
            h('div', { className: 'dm_skBar' }),
          )

        const renderStorage = () => {
          const dir = typeof storage.dir === 'string' ? storage.dir : ''
          const files = Array.isArray(storage.files) ? storage.files : []
          const dbField = fieldsByKey.get('storage.dbPath')
          const settingsPath = typeof storage.settingsPath === 'string' ? storage.settingsPath : ''
          // `storage.dbPath` is the handle actually open, and `active` is the
          // same path reported by the storage field; the field's `value` is what
          // the *next* start would use. The two differ exactly when the user
          // saved a new path and has not restarted dsh yet.
          const runningDbPath = typeof storage.dbPath === 'string' ? storage.dbPath : ''
          const activeDbPath = dbField !== undefined && typeof dbField.active === 'string' ? dbField.active : ''
          const currentDbPath = runningDbPath !== '' ? runningDbPath : activeDbPath
          const configuredDbPath = dbField !== undefined && typeof dbField.value === 'string' ? dbField.value : ''
          const pendingDbPath = configuredDbPath !== '' && configuredDbPath !== currentDbPath ? configuredDbPath : ''
          return h(
            'div',
            { className: 'dm_card' },
            h(
              'div',
              { className: 'dm_cardHead' },
              h(
                'div',
                { className: 'dm_cardText' },
                h('div', { className: 'dm_cardTitle' }, tr('storageTitle', 'Memory directory')),
                h('div', { className: 'dm_cardHint' }, tr('storageHint', '')),
              ),
              h(
                'div',
                { className: 'dm_actions' },
                h(
                  'button',
                  { type: 'button', className: 'dm_btn', onClick: copyPath, disabled: dir === '', title: tr('copyPath', 'Copy path') },
                  CopyIcon(),
                  tr('copyPath', 'Copy path'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dm_btn', onClick: reveal, disabled: dir === '' || busy !== '', title: tr('openDir', 'Open folder') },
                  FolderIcon(),
                  tr('openDir', 'Open folder'),
                ),
              ),
            ),
            h('div', { className: 'dm_path', title: dir }, dir === '' ? '—' : dir),
            storage.error !== undefined && storage.error !== null
              ? h('div', { className: 'dm_empty' }, String(storage.error))
              : null,
            h(
              'div',
              { className: 'dm_files' },
              h(
                'div',
                { className: 'dm_filesHead' },
                h('span', null, tr('files', 'Files')),
                h('span', { className: 'dm_filesTotal' }, tr('dbSize', 'Database size') + ' ' + formatBytes(stats.dbBytes)),
              ),
              files.length === 0
                ? h('div', { className: 'dm_empty' }, tr('noFiles', 'No files yet'))
                : files.map((file, index) => {
                    const name = file !== null && typeof file === 'object' && typeof file.name === 'string' ? file.name : ''
                    return h(
                      'div',
                      { className: 'dm_file', key: name !== '' ? name : 'file-' + index },
                      h('span', { className: 'dm_fileName' }, name !== '' ? name : '—'),
                      h('span', { className: 'dm_fileSize' }, formatBytes(file !== null && typeof file === 'object' ? file.bytes : undefined)),
                      h('span', { className: 'dm_fileTime' }, formatTime(file !== null && typeof file === 'object' ? file.modifiedAt : undefined)),
                    )
                  }),
            ),
            h(
              'div',
              { className: 'dm_kv' },
              h('span', { className: 'dm_kvLabel' }, tr('dbPath', 'Database path')),
              h('span', { className: 'dm_kvValue' }, currentDbPath === '' ? '—' : currentDbPath),
            ),
            pendingDbPath !== ''
              ? h(
                  'div',
                  { className: 'dm_kv' },
                  h('span', { className: 'dm_kvLabel' }, tr('pendingDbPath', 'Database after restart')),
                  h('span', { className: 'dm_kvValue', title: tr('restartBadgeTitle', '') }, pendingDbPath),
                  h('span', { className: 'dm_badge dm_badgeRestart', title: tr('restartBadgeTitle', '') }, tr('restartBadge', 'Restart')),
                )
              : null,
            h(
              'div',
              { className: 'dm_kv' },
              h('span', { className: 'dm_kvLabel' }, tr('settingsPath', 'Settings file')),
              h('span', { className: 'dm_kvValue' }, settingsPath === '' ? '—' : settingsPath),
              storage.settingsExists === false ? h('span', { className: 'dm_badge' }, tr('settingsMissing', 'not created')) : null,
            ),
          )
        }

        const renderStats = () => {
          const tiles = [
            ['statsTotal', stats.total],
            ['statsFacts', stats.facts],
            ['statsEpisodes', stats.episodes],
            ['statsPending', stats.l0Pending],
            ['statsScenes', stats.scenes],
            ['statsPersonas', stats.personas],
            ['statsTokens', stats.tokensSpent],
          ]
          return h(
            'div',
            { className: 'dm_card' },
            h('div', { className: 'dm_cardText' }, h('div', { className: 'dm_cardTitle' }, tr('statsTitle', 'Statistics'))),
            h(
              'div',
              { className: 'dm_stats' },
              tiles.map(tile =>
                h(
                  'div',
                  { className: 'dm_stat', key: tile[0] },
                  h('div', { className: 'dm_statValue' }, formatCount(tile[1])),
                  h('div', { className: 'dm_statLabel' }, tr(tile[0], tile[0])),
                ),
              ),
            ),
          )
        }

        /**
         * The entry point to the row browser: one card with the stored count and
         * the button that opens the data window.
         */
        const renderDataCard = () =>
          h(
            'div',
            { className: 'dm_card' },
            h(
              'div',
              { className: 'dm_cardHead' },
              h(
                'div',
                { className: 'dm_cardText' },
                h('div', { className: 'dm_cardTitle' }, tr('dataTitle', 'Memory data')),
                h('div', { className: 'dm_cardHint' }, tr('dataHint', '')),
              ),
              h(
                'div',
                { className: 'dm_actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dm_btn dm_btnPrimary',
                    onClick: openData,
                    title: tr('dataOpenTitle', 'Open the memory data window'),
                  },
                  tr('dataOpen', 'Manage data'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dm_dataSummary' },
              h('span', { className: 'dm_dataSummaryItem' }, fill(tr('dataTotal', '{n} entries'), { n: formatCount(stats.total) })),
              h('span', { className: 'dm_dataSummaryItem' }, tr('statsFacts', 'Facts') + ' ' + formatCount(stats.facts)),
              h('span', { className: 'dm_dataSummaryItem' }, tr('statsEpisodes', 'Episodes') + ' ' + formatCount(stats.episodes)),
              stats.l0Pending > 0
                ? h(
                    'span',
                    { className: 'dm_dataSummaryItem' },
                    tr('statsPending', 'Pending') + ' ' + formatCount(stats.l0Pending),
                  )
                : null,
            ),
          )

        /** Render one control for a field, driven by its host-reported type. */
        const renderControl = (field, type) => {
          const draft = draftOf(field)
          const label = tr(field.key, field.key)
          if (type === 'boolean') {
            return h(
              'button',
              {
                type: 'button',
                role: 'switch',
                className: 'dm_switch',
                'data-on': draft === true ? 'true' : undefined,
                'aria-checked': draft === true ? 'true' : 'false',
                'aria-label': label,
                disabled: busy === 'save' || busy === 'reset',
                onClick: () => editField(field.key, draft !== true),
              },
              h('span', { className: 'dm_switchThumb' }),
            )
          }
          if (type === 'enum') {
            const options = Array.isArray(field.options) ? field.options : []
            const current = draft === null || draft === undefined ? '' : String(draft)
            return h(
              'select',
              {
                className: 'dm_select',
                value: current,
                'aria-label': label,
                disabled: busy === 'save' || busy === 'reset',
                onChange: event => editField(field.key, event.target.value),
              },
              options.map(option => {
                const value = optionValue(option)
                const optionLabel =
                  value === ''
                    ? tr('autoOption', 'Follow default')
                    : typeof option === 'object' && option !== null && typeof option.label === 'string' && option.label !== ''
                      ? option.label
                      : tr('option.' + field.key + '.' + value, value)
                return h('option', { key: 'option-' + field.key + '-' + value, value: value }, optionLabel)
              }),
            )
          }
          if (type === 'number') {
            return h('input', {
              type: 'number',
              inputMode: 'numeric',
              className: 'dm_input',
              value: draft === null || draft === undefined ? '' : String(draft),
              min: typeof field.min === 'number' ? field.min : undefined,
              max: typeof field.max === 'number' ? field.max : undefined,
              step: typeof field.step === 'number' ? field.step : 'any',
              'aria-label': label,
              disabled: busy === 'save' || busy === 'reset',
              onChange: event => editField(field.key, event.target.value),
            })
          }
          return h('input', {
            type: 'text',
            className: 'dm_input dm_inputWide',
            value: draft === null || draft === undefined ? '' : String(draft),
            placeholder: tr('textPlaceholder', ''),
            'aria-label': label,
            disabled: busy === 'save' || busy === 'reset',
            onChange: event => editField(field.key, event.target.value),
          })
        }

        const renderField = (field, first) => {
          const type = typeof field.type === 'string' ? field.type : 'text'
          const source = typeof field.source === 'string' ? field.source : 'default'
          const sourceClass =
            source === 'settings' ? 'dm_badge dm_badgeSettings' : source === 'config' ? 'dm_badge dm_badgeConfig' : 'dm_badge dm_badgeDefault'
          const sourceText =
            source === 'settings'
              ? tr('sourceSettings', 'Settings')
              : source === 'config'
                ? tr('sourceConfig', 'YAML')
                : tr('sourceDefault', 'Default')
          const description = tr(field.key + '.description', '')
          const resetPending = isReset(field.key)
          const dirty = fieldDirty(field)
          const canReset = source === 'settings' || resetPending
          const liveNote =
            field.live === false && field.active !== undefined && !sameValue(field.active, field.value)
              ? tr('liveValueNow', 'Running with: ') +
                (field.active === '' || field.active === null || field.active === undefined
                  ? tr('emptyValue', '(empty)')
                  : String(field.active))
              : ''
          return h(
            'div',
            { className: first === true ? 'dm_field dm_fieldFirst' : 'dm_field', key: field.key },
            h(
              'div',
              { className: 'dm_fieldText' },
              h(
                'div',
                { className: 'dm_fieldLabel' },
                h('span', null, tr(field.key, field.key)),
                h('code', { className: 'dm_key' }, field.key),
              ),
              description !== '' ? h('div', { className: 'dm_fieldDesc' }, description) : null,
              liveNote !== '' ? h('div', { className: 'dm_fieldNote' }, liveNote) : null,
            ),
            h(
              'div',
              { className: 'dm_fieldSide' },
              h(
                'div',
                { className: 'dm_control' },
                renderControl(field, type),
                canReset
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: resetPending ? 'dm_linkBtn dm_linkBtnActive' : 'dm_linkBtn',
                        title: tr('resetFieldTitle', ''),
                        'aria-pressed': resetPending ? 'true' : 'false',
                        onClick: () => toggleReset(field),
                      },
                      resetPending ? tr('pendingReset', 'Pending reset') : tr('resetField', 'Reset'),
                    )
                  : null,
              ),
              h(
                'div',
                { className: 'dm_badges' },
                dirty && !resetPending ? h('span', { className: 'dm_badge dm_badgeDirty' }, tr('unsavedBadge', 'Unsaved')) : null,
                h('span', { className: sourceClass, title: tr('sourceTitle', '') }, sourceText),
                field.live === false
                  ? h('span', { className: 'dm_badge dm_badgeRestart', title: tr('restartBadgeTitle', '') }, tr('restartBadge', 'Restart'))
                  : null,
              ),
            ),
          )
        }

        const renderGroup = (group, index) => {
          const id = typeof group.id === 'string' ? group.id : ''
          const description = tr('group.' + id + '.description', '')
          return h(
            'div',
            { className: 'dm_card', key: id !== '' ? 'group-' + id : 'group-' + index },
            h(
              'div',
              { className: 'dm_cardText' },
              h('div', { className: 'dm_cardTitle' }, tr('group.' + id, id)),
              description !== ''
                ? h('div', { className: 'dm_cardHint' }, description)
                : h('div', { className: 'dm_cardHint' }, fill(tr('paramsHint', '{n} settings'), { n: group.fields.length })),
            ),
            group.fields.map((field, fieldIndex) => renderField(field, fieldIndex === 0)),
          )
        }

        const renderBar = () =>
          h(
            'div',
            { className: 'dm_bar' },
            dirtyCount > 0
              ? h(
                  'button',
                  { type: 'button', className: 'dm_btn dm_btnPrimary', onClick: save, disabled: busy !== '' },
                  busy === 'save' ? tr('saving', 'Saving…') : fill(tr('saveWithCount', 'Save ({n})'), { n: dirtyCount }),
                )
              : null,
            dirtyCount > 0
              ? h('button', { type: 'button', className: 'dm_btn', onClick: discard, disabled: busy !== '' }, tr('discard', 'Discard'))
              : null,
            h('span', { className: 'dm_barSpacer' }),
            notice !== '' ? h('span', { className: 'dm_status dm_statusOk' }, notice) : null,
            h(
              'button',
              { type: 'button', className: 'dm_btn dm_btnDanger', onClick: resetBaseline, disabled: busy !== '' },
              busy === 'reset' ? tr('resetting', 'Restoring…') : tr('resetBaseline', 'Restore YAML baseline'),
            ),
          )

        // ── page ────────────────────────────────────────────────────────────

        if (state === null) {
          return h(
            'div',
            { className: 'dm_section' },
            renderHead(),
            loadError !== null ? renderAlert(loadError, true) : null,
            loadError === null ? renderSkeleton() : null,
            actionError !== null ? renderAlert(actionError, false) : null,
          )
        }

        return h(
          'div',
          { className: 'dm_section' },
          renderHead(),
          loadError !== null ? renderAlert(loadError, true) : null,
          actionError !== null ? renderAlert(actionError, false) : null,
          renderStorage(),
          renderStats(),
          renderDataCard(),
          h(
            'div',
            { className: 'dm_groupHead' },
            h('div', { className: 'dm_cardTitle' }, tr('paramsTitle', 'Parameters')),
            h('div', { className: 'dm_cardHint' }, fill(tr('paramsHint', '{n} settings'), { n: fields.length })),
          ),
          groups.map(renderGroup),
          renderBar(),
          dataOpen ? h(MemoryDataBrowser, { onClose: closeData, onChanged: load }) : null,
        )
      }
    }

    // The page owns one stylesheet for the bundle's whole lifetime: inject it
    // when the factory materializes so the client module system can inventory
    // the tag against this package (and HMR keeps a single copy).
    installStyle()

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => registerDictionaries(ctx.locale), 'dsh-memory: zh/en dictionaries')
        const t = ctx.locale.bind(NS)
        const MemorySection = createSection(ctx.locale, t)
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'memory',
              order: 60,
              label: () => t('section'),
            },
            MemorySection,
          ),
        )
      },
    }
  },
})
