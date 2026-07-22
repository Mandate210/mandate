import AppShell from '@/components/AppShell'
import { ScenarioProvider } from '@/lib/scenario'
import { Route, Routes } from 'react-router-dom'
import IncidentTimeline from './pages/IncidentTimeline'
import NotFound from './pages/NotFound'
import Pools from './pages/Pools'
import ProtocolDetail from './pages/ProtocolDetail'
import VerificationTrail from './pages/VerificationTrail'

const App = () => (
  <ScenarioProvider>
    <AppShell>
      <Routes>
        <Route path="/" element={<Pools />} />
        <Route path="/protocol/:id" element={<ProtocolDetail />} />
        <Route path="/incident/:id" element={<IncidentTimeline />} />
        <Route path="/incident/:id/verify" element={<VerificationTrail />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AppShell>
  </ScenarioProvider>
)

export default App
