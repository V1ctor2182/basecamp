import MarkdownDocEditor from '../MarkdownDocEditor'

export default function Narrative() {
  return (
    <MarkdownDocEditor
      apiPath="/api/career/narrative"
      title="Narrative"
      subtitle="你的人设 / north star / 写作风格 — Applier 起草开放题、Evaluator Stage B 评估匹配度都读。骨架 H2 段名是和下游模块的软契约：删段名前确认下游不依赖。"
      saveLabel="Save Narrative"
    />
  )
}
