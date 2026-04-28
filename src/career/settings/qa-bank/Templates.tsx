import MarkdownDocEditor from '../../MarkdownDocEditor'

export default function Templates() {
  return (
    <MarkdownDocEditor
      apiPath="/api/career/qa-bank/templates"
      title="Templates"
      subtitle="开放题模板库 — Why us / Why role / Expected salary / Start date / Weakness 等。Applier Class 3 Open-Ended 读这里做模板匹配 + 填变量 + LLM 润色。templates.md committed (不敏感)。"
      saveLabel="Save Templates"
    />
  )
}
