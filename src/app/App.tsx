import { AppProviders } from './providers/AppProviders';
import { AppShell } from './layout/AppShell';

export function App() {
  return (
    <AppProviders>
      <AppShell />
    </AppProviders>
  );
}
