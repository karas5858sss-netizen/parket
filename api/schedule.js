const BASE = 'http://94.180.56.248:8080/api';
let cachedToken = null;
let tokenExpiry = 0;
 
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(BASE + '/tokenauth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      userName: process.env.MAI_LOGIN,
      password: process.env.MAI_PASSWORD,
      captchaCode: '', captchaKey: '',
      fingerprint: 'vercel-parket',
      isParent: false, qrRequestId: null, redirect: false
    })
  });
  const json = await res.json();
  const token = (json.data && json.data.data && json.data.data.accessToken)
             || (json.data && json.data.accessToken)
             || json.accessToken;
  if (!token) throw new Error('token not found state=' + json.state + ' msg=' + json.msg);
  cachedToken = token;
  tokenExpiry = Date.now() + 6 * 60 * 60 * 1000;
  return token;
}
 
// Запрос с таймаутом 4 секунды
async function fetchWeekSafe(token, sdate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(BASE + '/Rasp?idGroup=271&sdate=' + sdate, {
      headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data && json.data.rasp) || [];
  } catch (e) {
    clearTimeout(timer);
    return []; // таймаут или ошибка — возвращаем пустой массив, не падаем
  }
}
 
function getMondays() {
  const list = [];
  const d = new Date();
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  d.setHours(0, 0, 0, 0);
 
  // Конец: через 3 месяца, но не больше 16 недель (чтобы не таймаутить)
  const end = new Date();
  end.setMonth(end.getMonth() + 3);
  const maxWeeks = 16;
  let count = 0;
 
  while (d <= end && count < maxWeeks) {
    list.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 7);
    count++;
  }
  return list;
}
 
function parseDisc(raw) {
  if (!raw) return { type: 'пр', name: '' };
  const m = raw.match(/^(лек|пр|лаб)\s+(.+)$/);
  return m ? { type: m[1], name: m[2].trim() } : { type: 'пр', name: raw.trim() };
}
 
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
 
  try {
    const token = await getToken();
    const mondays = getMondays();
    const allLessons = [], seen = new Set();
 
    // По 3 недели параллельно — быстрее и меньше риск таймаута
    for (let i = 0; i < mondays.length; i += 3) {
      const chunk = mondays.slice(i, i + 3);
      const results = await Promise.all(chunk.map(w => fetchWeekSafe(token, w)));
      for (const arr of results) {
        for (const l of arr) {
          if (!seen.has(l['код'])) { seen.add(l['код']); allLessons.push(l); }
        }
      }
    }
 
    allLessons.sort((a, b) => new Date(a['датаНачала']) - new Date(b['датаНачала']));
 
    const lessons = allLessons.map(l => {
      const pd = parseDisc(l['дисциплина']);
      return {
        id: 'srv_' + l['код'], name: pd.name, type: pd.type,
        date: (l['дата'] || '').split('T')[0],
        ts: l['начало'] || '', te: l['конец'] || '',
        teacher: l['преподаватель'] || '', room: l['аудитория'] || '',
        pairs: 1, isReplacement: l['замена'] || false, rawCode: l['код']
      };
    });
 
    res.setHeader('Cache-Control', 'public, max-age=21600');
    res.status(200).json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      weeksChecked: mondays.length,
      total: lessons.length,
      lessons
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
