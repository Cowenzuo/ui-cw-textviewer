/**
 * Text viewer dock: a right-side panel rendered into the official
 * `shell.overlay` slot. Two layers inside: the lazy file TREE (navigation)
 * and the text PREVIEW region (the per-extension renderer registry), split
 * by a draggable height divider. The dock sits directly LEFT of the
 * ui-cw-fileexplorer dock and collapses independently to a slim rail.
 *
 * Geometry is fully owned by this component — no official source changes:
 * a `#root { margin-right }` stylesheet pushes the official UI left (the
 * dsh-better-sidebar-validated technique), now with the COMBINED width of
 * both docks (this dock reads the fileexplorer's width variable, so the two
 * yield the conversation area together). The dock width drag lives on the
 * left edge; collapsing the whole dock leaves a full-height bar with a
 * vertically centered expand arrow. The region follows the currently
 * selected session's workspace through the global session hooks. All data
 * arrives through props; the poll effects are pure behavioral hooks.
 */
import { useEffect, useRef, useState } from 'react'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { FileTree, type TextviewerTreeInjected } from './FileTree.tsx'
import { TextViewer } from './TextViewer.tsx'
import css from './TextViewerDock.module.css'

/** Business callbacks injected by the register site (apply world). */
export interface TextviewerInjected extends TextviewerTreeInjected {
  /** Read one decoded chunk of a file inside the locked root. */
  readText(root: string, path: string, offset: number, limit: number | undefined, signal: AbortSignal): Promise<import('@deepseek-ai/dsh-host-apiproxy/api').RpcResult<import('../contract.ts').TextviewerSnapshot>>
  /** Fetch the lazy renderer bundle source (throws on transport failure). */
  rendererBundle(): Promise<string>
}

/** Default expanded width in px. */
const DEFAULT_WIDTH = 380
/** Expanded width drag bounds. */
const MIN_WIDTH = 200
const MAX_WIDTH = 720
/** Collapsed rail width: a slim vertical tab keeps the expand affordance visible. */
const RAIL_WIDTH = 28
/** Default share of the dock height the tree takes. */
const DEFAULT_TREE_RATIO = 0.38
/** Tree-region height drag bounds (the preview keeps the remainder). */
const MIN_TREE_RATIO = 0.2
const MAX_TREE_RATIO = 0.7
/** CSS variables: this dock's width, and the sibling fileexplorer dock's width. */
const WIDTH_VAR = '--dsh-textviewer-width'
const FILEEXPLORER_WIDTH_VAR = '--dsh-fileexplorer-width'

/**
 * Seamless title-bar toggle: the whole title row collapses/expands on click,
 * but a press that was really a text-selection drag (pointer moved beyond the
 * click threshold) or a click with a live selection does nothing — copying a
 * path out of the title must never collapse the panel. Inside controls stop
 * propagation, so the collapse button keeps its own behavior.
 */
function useTitleClick(toggle: () => void): {
  onPointerDown: (event: React.PointerEvent) => void
  onClick: (event: React.MouseEvent) => void
} {
  const downRef = useRef<{ x: number; y: number } | null>(null)
  return {
    onPointerDown: (event) => { downRef.current = { x: event.clientX, y: event.clientY } },
    onClick: (event) => {
      const selection = window.getSelection()
      if (selection !== null && selection.toString() !== '') return
      const start = downRef.current
      downRef.current = null
      if (start !== null && Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 4) return
      toggle()
    },
  }
}

/** Current dark/light palette: ui-layout projects it onto body. */
function useDark(): boolean {
  const [dark, setDark] = useState(() => document.body.hasAttribute('data-ds-dark-theme'))
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.body.hasAttribute('data-ds-dark-theme'))
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => { observer.disconnect() }
  }, [])
  return dark
}

/** Root-level push stylesheet: the official UI yields to BOTH right docks. */
const PUSH_CSS = [
  `:root { ${WIDTH_VAR}: ${RAIL_WIDTH}px; }`,
  // Combined margin: this dock reads the fileexplorer dock's width variable,
  // so the two push the conversation together (each falls back to 0 when the
  // sibling plugin is absent). The !important beats the sibling's own plain
  // margin rule regardless of stylesheet order.
  `#root { margin-right: calc(var(${FILEEXPLORER_WIDTH_VAR}, 0px) + var(${WIDTH_VAR}, 0px)) !important; transition: margin-right 160ms ease; }`,
  // While EITHER dock drags, the shared margin must track 1:1 (no transition).
  `:root[data-dsh-textviewer-dragging] #root, :root[data-dsh-fileexplorer-dragging] #root { transition: none !important; }`,
].join('\n')

/**
 * The dock: collapse rail ⇄ expanded two-region layout.
 * @param props - slot runtime + register inject face + locale.
 */
export function TextviewerDock(
  props: PropsRuntime<'shell.overlay'> & InjectFace<TextviewerInjected> & PropsLocale<typeof NS>,
): React.JSX.Element {
  const { useSessions, list, readText, rendererBundle, t } = props
  const sessionId = useSessions(state => state.current)
  // The session workspace is the viewer's locked root (VS Code style): the
  // view may only descend inside it, never escape upward.
  const cwd = useSessions(state => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd))
  const [selectedFile, setSelectedFile] = useState<{ name: string; path: string } | null>(null)
  const previousRoot = useRef(cwd)
  const root = cwd
  const dark = useDark()

  // Dock geometry: whole-dock expand + tree/preview height share, transient
  // (refresh restores the defaults), like the official widths.
  const [expanded, setExpanded] = useState(true)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [treeRatio, setTreeRatio] = useState(DEFAULT_TREE_RATIO)
  const [dragging, setDragging] = useState(false)
  const dragWidth = useRef<{ startX: number; startWidth: number; lastWidth: number } | null>(null)
  const dragTree = useRef<{ startY: number; startRatio: number; lastRatio: number } | null>(null)
  const titleClick = useTitleClick(() => setExpanded(false))
  const panelRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  // Mount the push stylesheet once; the width variables below drive it.
  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'ui-cw-textviewer'
    style.textContent = PUSH_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [])

  // Publish the push width: expanded pushes by the panel width, collapsed by
  // the rail width (the rail still occupies that strip, so consumers must not
  // see 0 — a bottom dock reading this variable would otherwise cover it).
  useEffect(() => {
    if (dragging) return // the drag loop writes the variable directly
    document.documentElement.style.setProperty(WIDTH_VAR, expanded ? `${width}px` : `${RAIL_WIDTH}px`)
  }, [expanded, width, dragging])

  /** Write the current drag width straight to the DOM (zero React renders). */
  const applyDragWidth = (next: number): void => {
    const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next))
    document.documentElement.style.setProperty(WIDTH_VAR, `${clamped}px`)
    if (panelRef.current !== null) panelRef.current.style.width = `${clamped}px`
    if (dragWidth.current !== null) dragWidth.current.lastWidth = clamped
  }

  const onWidthPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragWidth.current = { startX: event.clientX, startWidth: width, lastWidth: width }
    setDragging(true)
    document.documentElement.dataset.dshTextviewerDragging = ''
  }
  const onWidthPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = dragWidth.current
    if (current === null) return
    applyDragWidth(current.startWidth + (current.startX - event.clientX))
  }
  const onWidthPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = dragWidth.current
    dragWidth.current = null
    setDragging(false)
    delete document.documentElement.dataset.dshTextviewerDragging
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (current !== null) setWidth(current.lastWidth)
  }

  /** Write the current tree-region height share straight to the DOM. */
  const applyDragTree = (next: number): void => {
    const clamped = Math.min(MAX_TREE_RATIO, Math.max(MIN_TREE_RATIO, next))
    const rounded = Math.round(clamped * 1000) / 1000
    if (treeRef.current !== null) treeRef.current.style.flexBasis = `${rounded * 100}%`
    if (dragTree.current !== null) dragTree.current.lastRatio = rounded
  }

  const onTreeDividerPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragTree.current = { startY: event.clientY, startRatio: treeRatio, lastRatio: treeRatio }
    setDragging(true)
    document.documentElement.dataset.dshTextviewerDragging = ''
  }
  const onTreeDividerPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = dragTree.current
    if (current === null) return
    const height = panelRef.current?.clientHeight ?? 1
    // Dragging the divider up grows the tree region (its bottom edge rises).
    applyDragTree(current.startRatio + (current.startY - event.clientY) / height)
  }
  const onTreeDividerPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = dragTree.current
    dragTree.current = null
    setDragging(false)
    delete document.documentElement.dataset.dshTextviewerDragging
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (current !== null) setTreeRatio(current.lastRatio)
  }

  // A different workspace resets the selection (the tree re-roots itself).
  useEffect(() => {
    if (previousRoot.current !== cwd) {
      previousRoot.current = cwd
      setSelectedFile(null)
    }
  }, [cwd])

  return (
    <div
      ref={panelRef}
      data-dsh-textviewer
      className={css.panel}
      style={{
        position: 'fixed',
        top: 0,
        bottom: 0,
        // Left of the fileexplorer dock (absent sibling → flush to the edge).
        right: `calc(var(${FILEEXPLORER_WIDTH_VAR}, 0px))`,
        height: '100vh', // explicit full height: the rail's vertical centering depends on it
        // One step BELOW the sibling fileexplorer dock (30): our right edge
        // abuts its left-edge width-drag divider (a 7px hover strip that
        // reaches 3px across the boundary) — painting under it keeps that
        // strip fully interactive instead of covering its outer 3px.
        zIndex: 29,
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        overflow: 'hidden',
        width: expanded ? width : RAIL_WIDTH,
        // The transition animates collapse/expand and re-arms after a drag;
        // while dragging it is off so the pointer feels 1:1.
        transition: dragging ? 'none' : 'width 160ms ease',
      }}
    >
      {expanded && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('divider.label')}
          className={css.divider}
          onPointerDown={onWidthPointerDown}
          onPointerMove={onWidthPointerMove}
          onPointerUp={onWidthPointerUp}
          onPointerCancel={onWidthPointerUp}
        />
      )}
      {!expanded && (
        <div className={css.rail}>
          <button
            type="button"
            className={css.railButton}
            aria-label={t('expand.label')}
            title={t('expand.label')}
            onClick={() => { setExpanded(true) }}
          >
            <IconChevronLeftOutline14 size={14} />
          </button>
        </div>
      )}
      {expanded && (
        <>
          <div className={css.titleRow} {...titleClick}>
            <div className={css.title}>{t('view.title')}</div>
            <button
              type="button"
              className={css.toggle}
              aria-expanded={expanded}
              aria-label={t('collapse.label')}
              title={t('collapse.label')}
              onClick={(event) => { event.stopPropagation(); setExpanded(false) }}
            >
              <IconChevronRightOutline14 size={14} />
            </button>
          </div>
          {/* Tree region: its own title bar + share of the height. */}
          <div ref={treeRef} className={css.section} style={{ flexGrow: 0, flexShrink: 1, flexBasis: `${treeRatio * 100}%`, transition: dragging ? 'none' : 'flex-basis 160ms ease' }}>
            <div className={css.sectionTitle}>{t('tree.title')}</div>
            <div className={css.sectionBody}>
              {root === undefined ? (
                <div className={css.message}>{t('viewer.no-workspace')}</div>
              ) : (
                <FileTree
                  root={root}
                  list={list}
                  t={t}
                  selectedPath={selectedFile?.path ?? null}
                  onSelectFile={setSelectedFile}
                />
              )}
            </div>
          </div>
          {/* Divider between the tree and the preview region. */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('divider.label')}
            className={css.dividerH}
            onPointerDown={onTreeDividerPointerDown}
            onPointerMove={onTreeDividerPointerMove}
            onPointerUp={onTreeDividerPointerUp}
            onPointerCancel={onTreeDividerPointerUp}
          />
          {/* Preview region: flex-remaining; TextViewer owns its header+scroll. */}
          <div className={css.section} style={{ flexGrow: 1, flexShrink: 1, flexBasis: '0%', minHeight: 0 }}>
            {root === undefined ? (
              <div className={css.message}>{t('viewer.no-workspace')}</div>
            ) : (
              <TextViewer
                root={root}
                file={selectedFile}
                dark={dark}
                t={t}
                readText={readText}
                rendererBundle={rendererBundle}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
