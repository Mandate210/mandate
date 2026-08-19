import { ArrowUpRight } from 'lucide-react'

/**
 * The program this interface is *about*, on the cluster it actually runs on.
 *
 * Kept here rather than in `mockData.ts` on purpose: everything in that file is
 * invented, and this is the one address on the page that is real.
 */
const PROGRAM_ID = 'DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P'
const EXPLORER = `https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`

/**
 * Says, above everything else, that the numbers below are made up.
 *
 * There is already a line in the footer, but a footer is under the fold and dim —
 * somebody who opens this link sees an incident, a quorum and a payout long before
 * they see any qualifier. For a product about insurance payouts that reads as a
 * record of something that happened, which is exactly the false impression
 * `docs/PLAN.md` → «Чого M0 не доводить» warns about.
 *
 * Deliberately not in the `alert` palette: those colours mean «an incident is open»
 * everywhere else in this interface, and a banner wearing them would be one more
 * thing to misread rather than the thing that prevents a misreading.
 */
const DemoNotice = () => (
  <div className="border-b border-border-strong bg-surface-raised">
    <div className="mx-auto w-full max-w-[1400px] px-6 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="mono text-[10px] uppercase tracking-[0.2em] font-semibold text-foreground">
        Demo
      </span>
      <span className="text-[12px] text-muted-foreground">
        Every protocol, incident and payout below is fabricated. No real protocol has been
        compromised, and none of these addresses belongs to anybody.
      </span>
      <a
        href={EXPLORER}
        target="_blank"
        rel="noreferrer"
        className="mono text-[10px] uppercase tracking-[0.16em] inline-flex items-center gap-1 text-foreground underline underline-offset-4 decoration-border-strong hover:decoration-foreground transition-colors duration-150"
      >
        The live program on devnet
        <ArrowUpRight className="h-3 w-3" strokeWidth={2.5} />
      </a>
    </div>
  </div>
)

export default DemoNotice
