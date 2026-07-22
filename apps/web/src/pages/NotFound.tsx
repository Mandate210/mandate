import { Link } from 'react-router-dom'

const NotFound = () => (
  <div className="py-24 text-center">
    <div className="mono text-[13px] uppercase tracking-[0.18em] text-dim-foreground">
      404 — route not found
    </div>
    <Link
      to="/"
      className="mt-4 inline-block mono text-[12px] uppercase tracking-[0.14em] text-foreground underline underline-offset-4"
    >
      Back to pools
    </Link>
  </div>
)

export default NotFound
