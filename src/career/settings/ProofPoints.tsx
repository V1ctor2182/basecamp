import MarkdownDocEditor from '../MarkdownDocEditor'

export default function ProofPoints() {
  return (
    <MarkdownDocEditor
      apiPath="/api/career/proof-points"
      title="Proof Points"
      subtitle="项目指标 / 文章 / 开源贡献明细 — Evaluator 反查防幻觉，CV Tailor 引用做简历。骨架 H2 段名是软契约：## Shipped Projects / ## Writing / ## Open Source / ## Quantified Wins。"
      saveLabel="Save Proof Points"
    />
  )
}
