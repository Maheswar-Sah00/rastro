import { useData } from '../lib/data';
import { TEAM } from '../lib/content';
import { fmtDate } from '../lib/format';

export function Footer() {
  const meta = useData('meta');
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div style={{ maxWidth: 620 }}>
          <div className="tagline-foot">A cow is born once, dies once, and can't be in two places. Neither can its paperwork.</div>
          <p style={{ margin: '10px 0 0' }}>
            {meta.data?.synthetic_notice ??
              'Ranch boundaries, herds and movement permits are synthetic, calibrated to public aggregates. Deforestation, protected areas and slaughterhouse locations are real.'}
          </p>
          <p style={{ margin: '8px 0 0' }}>
            Embargoes, voyage destinations and buyers are simulated too. Slaughterhouse names are anonymised; nothing on this site implies anything
            about a real company, ranch or person.
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div>
            <b style={{ color: 'var(--ink)' }}>Rastro</b> · IEEE ClimateChain Global Hackathon 2026
          </div>
          <div>Sustainable supply chains track</div>
          <div>Team: {TEAM.members.join(' · ')}</div>
          {meta.data?.generated_at && <div>Data run {fmtDate(meta.data.generated_at.slice(0, 10))}</div>}
          <div>
            <a href="./console.html">Analyst console</a> (needs the Rastro API)
          </div>
          <div>
            <a href={TEAM.repo} target="_blank" rel="noreferrer">
              Code on GitHub ↗
            </a>{' '}
            ·{' '}
            <a href={`${TEAM.repo}#13-limitations-and-roadmap`} target="_blank" rel="noreferrer">
              Limitations and roadmap ↗
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
