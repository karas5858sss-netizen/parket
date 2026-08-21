const BASE = 'http://94.180.56.248:8080/api';

let cachedToken = null;
let tokenExpiry = 0;

// Кэш годов/групп — обновляется раз в CACHE_TTL, не дёргаем API на каждый запрос
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 часов
let cachedYears = null, yearsExpiry = 0;
let cachedGroups = null, groupsExpiry = 0, cachedGroupsYear = null;

// TODO: перевести на raspTeacherlist/raspAudlist тем же способом, когда будет форма ответа
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

// Текущий учебный год — берём последний из списка, который отдаёт сам университет.
// Не наше дело гадать даты семестра — просто спрашиваем у API.
async function getCurrentYear(token) {
  if (cachedYears && Date.now() < yearsExpiry) return cachedYears[cachedYears.length - 1];
  const res = await fetch(BASE + '/ListYears', {
    headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token }
  });
  const json = await res.json();
  const years = json.data && json.data.years;
  if (!Array.isArray(years) || !years.length) throw new Error('ListYears: пустой ответ');
  cachedYears = years;
  yearsExpiry = Date.now() + CACHE_TTL;
  return years[years.length - 1];
}

// Список групп на конкретный год (кэшируется отдельно от токена)
async function getGroupList(token, year) {
  if (cachedGroups && cachedGroupsYear === year && Date.now() < groupsExpiry) return cachedGroups;
  const res = await fetch(`${BASE}/raspGrouplist?year=${year}`, {
    headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token }
  });
  const json = await res.json();
  if (!Array.isArray(json.data)) throw new Error('raspGrouplist: пустой ответ');
  cachedGroups = json.data;
  cachedGroupsYear = year;
  groupsExpiry = Date.now() + CACHE_TTL;
  return cachedGroups;
}

// Найти группу по id ("338") или по имени ("Мо-24") — id теперь меняется от года к году,
// имя — единственное, что стабильно из года в год
function resolveGroup(groups, { groupId, groupName }) {
  if (groupId != null) return groups.find(g => String(g.id) === String(groupId)) || null;
  if (groupName) return groups.find(g => g.name.toLowerCase() === groupName.toLowerCase()) || null;
  return null;
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

// Скользящее окно вместо хардкода конца семестра. API не отдаёт границы семестра явно,
// поэтому просто берём с запасом — 30 недель это ~7 месяцев, хватает на любой семестр целиком.
function getMondays(weeksAhead = 30) {
  const list = [];
  const d = new Date();
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < weeksAhead; i++) {
    list.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 7);
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

    // Отдать сырой список групп на текущий год — фронту, чтобы строить пикер без хардкода
    if (req.query.list === 'groups') {
      const year = await getCurrentYear(token);
      const groups = await getGroupList(token, year);
      return res.status(200).json({ ok: true, year, groups });
    }

    let queryParam = null;
    let mode = 'group';

    if (req.query.groupId || req.query.group) {
      const year = await getCurrentYear(token);
      const groups = await getGroupList(token, year);
      const found = resolveGroup(groups, { groupId: req.query.groupId, groupName: req.query.group });
      if (!found) {
        return res.status(404).json({ ok: false, error: 'Группа не найдена', year, available: groups.map(g => g.name) });
      }
      queryParam = 'idGroup=' + found.id;
      mode = 'group';
    } else if (req.query.teacherId && ALLOWED_TEACHERS.has(req.query.teacherId)) {
      queryParam = 'idTeacher=' + req.query.teacherId;
      mode = 'teacher';
    } else if (req.query.audId && ALLOWED_AUDS.has(req.query.audId)) {
      queryParam = 'idAudLine=' + req.query.audId;
      mode = 'aud';
    } else {
      // Раньше тут был дефолт на группу 271 — на открытом приложении молчаливый дефолт
      // на чужую конкретную группу больше не имеет смысла, лучше явная ошибка
      return res.status(400).json({ ok: false, error: 'Укажи groupId, group, teacherId или audId' });
    }

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
