/**
 * ui-cw-textviewer dictionaries. Chinese is the key source, English mirrors
 * it; both halves share the namespace through the locale service.
 */

export const NS = 'ui-cw-textviewer'

export const zh = {
  'view.title': '文本查看器',
  'collapse.label': '隐藏面板',
  'divider.label': '调整宽度',
  'viewer.title': '预览',
  'viewer.empty': '在文件工作台点击文件查看',
  'viewer.loading': '读取中…',
  'viewer.binary': '二进制文件，暂不支持预览',
  'viewer.more': '已加载部分内容，滚动到底部继续加载',
  'viewer.source': '源码',
  'viewer.render': '渲染',
  'viewer.diagram': '图',
  'viewer.diagramError': '图示渲染失败',
  'history.label': '打开记录',
  'history.empty': '暂无打开记录',
  'error.load': '无法读取该文件',
} as const

export const en: Record<keyof typeof zh, string> = {
  'view.title': 'Text Viewer',
  'collapse.label': 'Hide panel',
  'divider.label': 'Resize',
  'viewer.title': 'Preview',
  'viewer.empty': 'Click a file in the file explorer to view it',
  'viewer.loading': 'Loading…',
  'viewer.binary': 'Binary file — preview not supported',
  'viewer.more': 'Partial content loaded — scroll to the bottom to load more',
  'viewer.source': 'Source',
  'viewer.render': 'Render',
  'viewer.diagram': 'Diagram',
  'viewer.diagramError': 'Diagram render failed',
  'history.label': 'History',
  'history.empty': 'No history yet',
  'error.load': 'Unable to read this file',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    [NS]: keyof typeof zh
  }
}
