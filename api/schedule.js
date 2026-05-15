const BASE = 'http://94.180.56.248:8080/api';
let cachedToken = null;
let tokenExpiry = 0;

const ALLOWED_GROUPS   = new Set(['270','271','272','274','275']);
const ALLOWED_TEACHERS = new Set(['6','7','9','10','13','23','24','30','32','34','46','50','54','55','57','62','63','69','73','75','76','77','78','82','83','85','86','89']);
const ALLOWED_AUDS     = new Set(['520644','520641','522375','520616','520617','520701','520628','520629','522235','520631','520914','520622','540794','540805','520635','541906','520672','540852','541023','540803','520736','540847','540840','540841','540837']);

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(BASE + '/tokenauth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      userName: process.env.MAI_LOGIN, password: process.env.MAI_PASSWORD,
      captchaCode: '', captchaKey: '', fingerprint: 'vercel-parket',
      isParent: false, qrRequestId: null, redirect: false
    })
  });
  const json = await res.json();
  const token = (json.data && json.data.data && json.data.data.accessToken)
             || (json.data && json.data.accessToken) || json.accessToken;
  if (!token) throw new Error('token not found state=' + json.state + ' msg=' + json.msg);
  cachedToken = token;
  tokenExpiry = Date.now() + 6 * 60 * 60 * 1000;
  return token;
}

async function fetchWeekSafe(token, queryParam, sdate) {
  try {
    const res = await fetch(BASE + '/Rasp?' + queryParam + '&sdate=' + sdate, {
      headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data && json.data.rasp) || [];
  } catch (e) { return []; }
}

function getMondays() {
  const list = [];
  const d = new Date();
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  d.setHours(0, 0, 0, 0);
  const end = new Date('2026-06-21');
  while (d <= end) { list.push(d.toISOString().split('T')[0]); d.setDate(d.getDate() + 7); }
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

  // Определяем тип запроса и параметр
  let queryParam = null;
  let mode = 'group';

  if (req.query.groupId && ALLOWED_GROUPS.has(req.query.groupId)) {
    queryParam = 'idGroup=' + req.query.groupId;
    mode = 'group';
  } else if (req.query.teacherId && ALLOWED_TEACHERS.has(req.query.teacherId)) {
    queryParam = 'idTeacher=' + req.query.teacherId;
    mode = 'teacher';
  } else if (req.query.audId && ALLOWED_AUDS.has(req.query.audId)) {
    queryParam = 'idAudLine=' + req.query.audId;
    mode = 'aud';
  } else {
    // По умолчанию — группа 271
    queryParam = 'idGroup=271';
    mode = 'group';
  }

  try {
    const token = await getToken();
    const mondays = getMondays();
    const results = await Promise.all(mondays.map(w => fetchWeekSafe(token, queryParam, w)));

    const allLessons = [], seen = new Set();
    for (const arr of results) {
      for (const l of arr) {
        if (!seen.has(l['код'])) { seen.add(l['код']); allLessons.push(l); }
      }
    }
    allLessons.sort((a, b) => new Date(a['датаНачала']) - new Date(b['датаНачала']));

    const lessons = allLessons.map(l => {
      const pd = parseDisc(l['дисциплина']);
      return {
        id:            'srv_' + l['код'],
        name:          pd.name,
        type:          pd.type,
        date:          (l['дата'] || '').split('T')[0],
        ts:            l['начало']        || '',
        te:            l['конец']         || '',
        teacher:       l['преподаватель'] || '',
        room:          l['аудитория']     || '',
        group:         l['группа']        || '',
        pairs:         1,
        isReplacement: l['замена']        || false,
        rawCode:       l['код']
      };
    });

    res.setHeader('Cache-Control', 'public, max-age=10800');
    res.status(200).json({ ok: true, mode, fetchedAt: new Date().toISOString(), total: lessons.length, lessons });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
