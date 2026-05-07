// Side-by-side markdown diff for the Tailor approve / reject flow.
// Wraps react-diff-viewer-continued so the constraint #2 contract
// ("UI MUST show diff before render") has a single, polished surface.
//
// Left = base.md (ground truth) / Right = tailored markdown (Sonnet output).
// User reads both before clicking Approve.

import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'

type Props = {
  base: string
  tailored: string
  leftTitle?: string
  rightTitle?: string
}

export default function DiffViewer({
  base,
  tailored,
  leftTitle = 'base.md (source of truth)',
  rightTitle = 'tailored',
}: Props) {
  return (
    <div className="tp-diff-frame">
      <ReactDiffViewer
        oldValue={base}
        newValue={tailored}
        splitView={true}
        leftTitle={leftTitle}
        rightTitle={rightTitle}
        // WORDS gives readable diffs for prose / markdown bullets.
        // CHARS would highlight micro-edits but visually overwhelms.
        compareMethod={DiffMethod.WORDS}
        useDarkTheme={false}
        styles={{
          contentText: { fontSize: 13, lineHeight: 1.55 },
          titleBlock: { fontSize: 12, fontWeight: 600 },
        }}
      />
    </div>
  )
}
