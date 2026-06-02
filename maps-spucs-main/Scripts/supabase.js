// ===== SUPABASE CONFIG =====
const SUPABASE_URL      = 'https://uuxzqpppblrwamevdbbl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1eHpxcHBwYmxyd2FtZXZkYmJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzMTY0MTUsImV4cCI6MjA5NTg5MjQxNX0.5krTDKSbqZE_4Tq5HztObDcqMASTltg_lNGZzK33dLQ';

const SUPABASE_HEADERS = {
  'apikey':        SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type':  'application/json'
};

async function supabaseFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SUPABASE_HEADERS });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status}: ${body}`);
  }
  return res.json();
}
