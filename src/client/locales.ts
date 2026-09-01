/**
 * ui-cw-textviewer dictionaries. Chinese is the key source, English mirrors
 * it; both halves share the namespace through the locale service.
 */

export const NS = 'ui-cw-textviewer'

export const zh = {
  'view.title': '文本查看器',
  'collapse.label': '收起面板',
  'expand.label': '展开面板',
  'divider.label': '调整宽度',
  'viewer.title': '预览',
  'viewer.empty': '在文件工作台点击文件查看',
  'viewer.loading': '读取中…',
  'viewer.binary': '二进制文件，暂不支持预览',
  'viewer.more': '已加载部分内容，滚动到底部继续加载',
  'viewer.too-large': '文件过大，仅预览前 2MB',
  'error.load': '无法读取该文件',
} as const

export const en: Record<keyof typeof zh, string> = {
  'view.title': 'Text Viewer',
  'collapse.label': 'Collapse panel',
  'expand.label': 'Expand panel',
  'divider.label': 'Resize',
  'viewer.title': 'Preview',
  'viewer.empty': 'Click a file in the file explorer to view it',
  'viewer.loading': 'Loading…',
  'viewer.binary': 'Binary file — preview not supported',
  'viewer.more': 'Partial content loaded — scroll to the bottom to load more',
  'viewer.too-large': 'File too large — previewing the first 2MB only',
  'error.load': 'Unable to read this file',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    [NS]: keyof typeof zh
  }
}
