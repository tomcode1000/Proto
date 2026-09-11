/**
 * Projects.
 *
 * A general contractor runs several sites at once, and a subcontractor on one is
 * rarely a subcontractor on all of them. Holding a single roster made Proto a
 * tool for whichever job happened to be open, which is not how the work goes.
 *
 * Each project is its own file: its own roster, its own watch, its own alert
 * channel and its own history. Nothing is shared between them except the code,
 * so deleting one cannot disturb another.
 */
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const DIR = 'data/projects'
const POINTER = 'data/active.json'

/** A readable id, because these become filenames a person may have to look at. */
export function slugify(name, taken = []) {
  const base =
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'project'

  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

export function blankProject(id, name = '') {
  return {
    id,
    project: name,
    generalContractor: '',
    county: 'MIAMI-DADE',
    subcontractors: [],
    schedule: { cadence: 'weekly', timeOfDay: '08:00', dayOfWeek: 1, lastRun: null, nextDue: null },
    notify: { telegram: { botToken: '', chatId: '', enabled: false }, onlyOnChange: true },
  }
}

const pathFor = (id) => join(DIR, `${id}.json`)

export async function listProjects() {
  await mkdir(DIR, { recursive: true })
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'))

  const out = []
  for (const file of files) {
    const raw = await readFile(join(DIR, file), 'utf8').catch(() => null)
    if (!raw) continue
    try {
      const p = JSON.parse(raw)
      out.push({
        id: p.id ?? file.replace(/\.json$/, ''),
        project: p.project ?? '',
        generalContractor: p.generalContractor ?? '',
        county: p.county ?? '',
        subcontractors: p.subcontractors?.length ?? 0,
        cadence: p.schedule?.cadence ?? 'weekly',
        nextDue: p.schedule?.nextDue ?? null,
      })
    } catch {
      // A single unreadable project must not hide the rest.
    }
  }
  return out.sort((a, b) => (a.project || a.id).localeCompare(b.project || b.id))
}

export async function activeId() {
  const raw = await readFile(POINTER, 'utf8').catch(() => null)
  if (raw) {
    try {
      const { id } = JSON.parse(raw)
      const exists = await readFile(pathFor(id), 'utf8').catch(() => null)
      if (exists) return id
    } catch {
      // fall through and pick one below
    }
  }

  const all = await listProjects()
  if (all.length) {
    await setActive(all[0].id)
    return all[0].id
  }

  // Nothing yet: create the first project so the app always has somewhere to be.
  const id = await createProject('')
  return id
}

export async function setActive(id) {
  await mkdir('data', { recursive: true })
  await writeFile(POINTER, JSON.stringify({ id }, null, 2) + '\n')
  return id
}

export async function createProject(name) {
  const all = await listProjects()
  const id = slugify(name, all.map((p) => p.id))
  await mkdir(DIR, { recursive: true })
  await writeFile(pathFor(id), JSON.stringify(blankProject(id, name), null, 2) + '\n')
  await setActive(id)
  return id
}

export async function readProject(id) {
  const raw = await readFile(pathFor(id), 'utf8').catch(() => null)
  return raw ? JSON.parse(raw) : null
}

export async function writeProject(project) {
  await mkdir(DIR, { recursive: true })
  await writeFile(pathFor(project.id), JSON.stringify(project, null, 2) + '\n')
  return project
}

export async function deleteProject(id) {
  await rm(pathFor(id), { force: true })
  await rm(join('data/history', `${id}.json`), { force: true })

  const remaining = await listProjects()
  if (remaining.length) await setActive(remaining[0].id)
  else await createProject('')
  return { deleted: id }
}

/**
 * Move a single legacy roster into the projects folder.
 *
 * Runs once. Anyone who had a roster before projects existed keeps it, under
 * its own name, rather than opening the app to an empty screen.
 */
export async function migrateLegacyRoster() {
  const all = await listProjects()
  if (all.length) return null

  const raw = await readFile('data/roster.json', 'utf8').catch(() => null)
  if (!raw) return null

  let legacy
  try {
    legacy = JSON.parse(raw)
  } catch {
    return null
  }

  const id = slugify(legacy.project || 'first-project', [])
  await mkdir(DIR, { recursive: true })
  await writeProject({ ...blankProject(id, legacy.project || ''), ...legacy, id })
  await setActive(id)
  return id
}
