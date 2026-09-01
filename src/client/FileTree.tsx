/**
 * File tree: the dock's navigation surface rendered as ONE lazy tree. The
 * workspace root's children load first; expanding a directory fetches its
 * level lazily (the same `list` endpoint). A poll refreshes the root level
 * and every EXPANDED directory in place — merging preserves each node's
 * expansion state, so the tree never collapses under the user. Hidden
 * entries stay off the surface (v1). No git states in v1: the viewer is
 * format-focused; clicking a file hands it to the preview region.
 */
import { useEffect, useRef, useState } from 'react'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { NS } from './locales.ts'
import type { TextviewerListing, TextviewerEntry } from '../contract.ts'
import css from './TextViewerDock.module.css'

export interface TextviewerTreeNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  size?: number
  /** Loaded children; null = the directory has not been expanded yet. */
  children: TextviewerTreeNode[] | null
  expanded: boolean
  /** The level was cut at the host's complete-result bound. */
  truncated: boolean
}

export interface TextviewerTreeInjected {
  list(root: string | undefined, path: string | undefined, signal: AbortSignal): Promise<RpcResult<TextviewerListing>>
}

const POLL_MS = 2_000

function toNode(entry: TextviewerEntry): TextviewerTreeNode {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    ...(entry.size === undefined ? {} : { size: entry.size }),
    children: null,
    expanded: false,
    truncated: false,
  }
}

/** Merge a fresh level into existing nodes, preserving expansion state. */
function mergeNodes(existing: TextviewerTreeNode[] | null, fresh: readonly TextviewerEntry[], truncated: boolean): TextviewerTreeNode[] {
  const byPath = new Map<string, TextviewerTreeNode>()
  if (existing !== null) for (const node of existing) byPath.set(node.path, node)
  return fresh.filter(entry => !entry.hidden).map(entry => {
    const prev = byPath.get(entry.path)
    return {
      ...toNode(entry),
      children: prev?.children ?? null,
      expanded: prev?.expanded ?? false,
      truncated: prev?.truncated ?? false,
      ...(truncated ? { truncated } : {}),
    }
  })
}

/** Recursively map one node (by path) — the single tree-mutation primitive. */
function mapAt(nodes: TextviewerTreeNode[], path: string, fn: (node: TextviewerTreeNode) => TextviewerTreeNode): TextviewerTreeNode[] {
  return nodes.map(node => {
    if (node.path === path) return fn(node)
    if (node.children !== null) return { ...node, children: mapAt(node.children, path, fn) }
    return node
  })
}

/** Paths of every expanded directory (breadth-first, root level first). */
function collectExpandedPaths(nodes: TextviewerTreeNode[]): string[] {
  const out: string[] = []
  const walk = (list: TextviewerTreeNode[]): void => {
    for (const node of list) {
      if (node.kind === 'dir' && node.expanded && node.children !== null) {
        out.push(node.path)
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return out
}

export function FileTree(props: {
  root: string
  list: TextviewerTreeInjected['list']
  t: TranslateNS<typeof NS>
  selectedPath: string | null
  onSelectFile: (file: { name: string; path: string } | null) => void
}): React.JSX.Element {
  const { root, list, t, selectedPath, onSelectFile } = props
  const [nodes, setNodes] = useState<TextviewerTreeNode[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Live mirror so the poll can read the current tree without stale closures.
  const nodesRef = useRef<TextviewerTreeNode[] | null>(null)
  const inFlight = useRef<Set<string>>(new Set())
  const setNodesBoth = (next: TextviewerTreeNode[] | null): void => {
    nodesRef.current = next
    setNodes(next)
  }
  const updateNodes = (fn: (prev: TextviewerTreeNode[]) => TextviewerTreeNode[]): void => {
    setNodesBoth(fn(nodesRef.current ?? []))
  }

  // Reset on workspace change; load the root level and poll it plus every
  // expanded directory in place.
  useEffect(() => {
    setNodesBoth(null)
    setError(null)
    if (root === undefined) return
    let cancelled = false
    const refreshAll = async (): Promise<void> => {
      const result = await list(root, undefined, new AbortController().signal)
      if (cancelled) return
      if (!result.ok) {
        // A failed ROOT load is the only fatal one: nothing is on screen
        // yet, so the listing's old error line is shown instead of a
        // spinner. Poll failures with data on screen keep the last tree.
        if (nodesRef.current === null) setError(result.error.message)
        return
      }
      setError(null)
      updateNodes(prev => mergeNodes(prev, result.value.entries, result.value.truncated))
      for (const path of collectExpandedPaths(nodesRef.current ?? [])) {
        const level = await list(root, path, new AbortController().signal)
        if (cancelled) return
        if (!level.ok) continue
        updateNodes(prev => mapAt(prev, path, node => ({
          ...node,
          children: mergeNodes(node.children, level.value.entries, level.value.truncated),
        })))
      }
    }
    void refreshAll()
    const timer = window.setInterval(() => { void refreshAll() }, POLL_MS)
    const onVisible = (): void => { if (document.visibilityState === 'visible') void refreshAll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- helpers read the live ref.
  }, [root, list])

  /** Toggle a directory: lazy-load its level on first expand. */
  const toggle = (node: TextviewerTreeNode): void => {
    if (node.kind !== 'dir') return
    if (node.children === null) {
      if (inFlight.current.has(node.path)) return
      inFlight.current.add(node.path)
      void list(root, node.path, new AbortController().signal).then(result => {
        inFlight.current.delete(node.path)
        if (!result.ok) return
        updateNodes(prev => mapAt(prev, node.path, current => ({
          ...current,
          children: mergeNodes(current.children, result.value.entries, result.value.truncated),
          expanded: true,
        })))
      })
      return
    }
    updateNodes(prev => mapAt(prev, node.path, current => ({ ...current, expanded: !current.expanded })))
  }

  const renderNode = (node: TextviewerTreeNode, depth: number): React.JSX.Element => {
    const selected = selectedPath !== null && node.path === selectedPath
    return (
      <li key={node.path}>
        <div
          role="button"
          tabIndex={0}
          className={selected ? `${css.treeRow} ${css.rowSelected}` : css.treeRow}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => { node.kind === 'dir' ? toggle(node) : onSelectFile({ name: node.name, path: node.path }) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              node.kind === 'dir' ? toggle(node) : onSelectFile({ name: node.name, path: node.path })
            }
          }}
          title={node.name}
        >
          <span className={css.treeTwisty} aria-hidden="true">
            {node.kind === 'dir'
              ? (node.expanded ? <IconChevronDownOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />)
              : <span className={css.treeDot} />}
          </span>
          <span className={css.name}>{node.name}</span>
          <span className={css.meta}>{node.kind === 'file' ? formatSize(node.size) : ''}</span>
        </div>
        {node.kind === 'dir' && node.expanded && node.children !== null && (
          <>
            <ul className={css.treeList}>{node.children.map(child => renderNode(child, depth + 1))}</ul>
            {node.truncated && <li className={css.message}>{t('error.load')}…</li>}
          </>
        )}
      </li>
    )
  }

  if (nodes === null) {
    return (
      <div className={css.message}>
        {error !== null ? `${t('error.load')}：${error}` : t('tree.loading')}
      </div>
    )
  }
  if (nodes.length === 0) {
    // An empty workspace renders as an empty tree area.
    return <></>
  }
  return <ul className={css.treeList}>{nodes.map(node => renderNode(node, 0))}</ul>
}

/** Compact byte size; the same presentation the explorer uses. */
function formatSize(size: number | undefined): string {
  if (size === undefined) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
