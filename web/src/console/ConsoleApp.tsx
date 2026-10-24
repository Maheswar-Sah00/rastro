import { DEMO_MODE } from './api/client';
import { Layout, useEnv } from './components/Layout';
import { Empty } from './components/States';
import { useRoute } from './lib/router';
import { Investigations, Certificates, Ledger, Evaluation, Sources } from './pages/Other';
import { LiveMap } from './pages/LiveMap';
import { GtaPage, LotPage, Movements } from './pages/Movements';
import { Overview } from './pages/Overview';
import { Ranches } from './pages/Ranches';
import { Shipments } from './pages/Shipments';

export default function ConsoleApp() {
  const route = useRoute();
  const { env } = useEnv();
  let page;
  switch (route.page) {
    case 'overview':
      page = <Overview />;
      break;
    case 'map':
      page = <LiveMap route={route} />;
      break;
    case 'ranches':
      page = <Ranches route={route} />;
      break;
    case 'movements':
      page = <Movements route={route} />;
      break;
    case 'gtas':
      page = route.id ? <GtaPage id={route.id} /> : <Movements route={route} />;
      break;
    case 'lots':
      page = route.id ? <LotPage id={route.id} /> : <Movements route={route} />;
      break;
    case 'shipments':
      page = <Shipments route={route} />;
      break;
    case 'investigations':
      page = <Investigations />;
      break;
    case 'certificates':
      page = <Certificates route={route} />;
      break;
    case 'ledger':
      page = <Ledger />;
      break;
    case 'evaluation':
      page = <Evaluation />;
      break;
    case 'sources':
      page = <Sources />;
      break;
    default:
      page = (
        <div className="page">
          <Empty title="Page not found">
            <a href="#/overview">Back to the overview</a>
          </Empty>
        </div>
      );
  }
  // Remount the page on navigation so each view starts from a clean state.
  return (
    <Layout page={route.page} env={env} demo={DEMO_MODE}>
      <div key={`${route.page}/${route.id || ''}`}>{page}</div>
    </Layout>
  );
}
