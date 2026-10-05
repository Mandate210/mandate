import AppShell from '@/components/AppShell'
import { Route, Routes } from 'react-router-dom'
import IncidentTimeline from './pages/IncidentTimeline'
import Incidents from './pages/Incidents'
import NotFound from './pages/NotFound'
import Pools from './pages/Pools'
import ProtocolDetail from './pages/ProtocolDetail'
import VerificationTrail from './pages/VerificationTrail'

const App = () => (
  <AppShell>
    <Routes>
      <Route path="/" element={<Pools />} />
      <Route path="/protocol/:id" element={<ProtocolDetail />} />
      <Route path="/incidents" element={<Incidents />} />
      <Route path="/incident/:id" element={<IncidentTimeline />} />
      <Route path="/incident/:id/verify" element={<VerificationTrail />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  </AppShell>
)

export default App
