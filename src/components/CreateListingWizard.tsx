import { useRef, useState } from 'react'
import { useBodyScrollLock } from '../lib/scrollLock'
import {
  ArrowLeft, ArrowRight, BadgeCheck, Building2, Check, ChevronLeft, ChevronRight,
  Globe2, ImagePlus, Loader2, Package, RotateCcw, ShieldAlert, Trash2, X,
} from 'lucide-react'
import * as mk from '../lib/marketplace'
import * as db from '../lib/db'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  identity: Identity | null
  configured: boolean
  colleges: db.College[]
  myCollegeId: string | null
  editing: mk.ListingDetail | null
  onClose: () => void
  onSaved: (slug: string | null) => void
  notify: (message: string) => void
}

type Photo = { url: string; state: 'uploading' | 'done' | 'error'; message?: string }

const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const STEPS = ['Item', 'Price', 'Photos', 'Audience', 'Handover', 'Preview'] as const

const TYPE_OPTIONS: { value: mk.ListingTxType; label: string; hint: string }[] = [
  { value: 'for_sale', label: 'For sale', hint: 'Ask a price, negotiate if you like' },
  { value: 'free', label: 'Free', hint: 'Give it away to someone who needs it' },
  { value: 'exchange', label: 'Exchange', hint: 'Trade it for something else' },
  { value: 'wanted', label: 'Wanted', hint: 'Describe what you are looking for' },
]

function emptyInput(): mk.ListingInput {
  return {
    title: '', description: '', category: mk.MARKET_CATEGORIES[0], txType: 'for_sale',
    condition: 'good', brand: null, model: null, quantity: 1, price: null,
    negotiable: false, budgetMax: null, exchangeFor: null, exchangeCash: false,
    images: [], audience: 'college', handover: 'campus_meetup', handoverSpot: null,
  }
}

export default function CreateListingWizard({
  identity, configured, colleges, myCollegeId, editing, onClose, onSaved, notify,
}: Props) {
  const [step, setStep] = useState(0)
  const [input, setInput] = useState<mk.ListingInput>(() => (editing ? {
    title: editing.title,
    description: editing.description,
    category: editing.category,
    txType: editing.transactionType,
    condition: editing.condition ?? 'good',
    brand: editing.brand,
    model: editing.model,
    quantity: editing.quantity,
    price: editing.price != null ? Number(editing.price) : null,
    negotiable: editing.negotiable,
    budgetMax: editing.budgetMax != null ? Number(editing.budgetMax) : null,
    exchangeFor: editing.exchangeFor,
    exchangeCash: editing.exchangeCash,
    images: editing.images,
    audience: editing.audience,
    handover: editing.handover,
    handoverSpot: editing.handoverSpot,
  } : emptyInput()))
  const [photos, setPhotos] = useState<Photo[]>(() => (editing?.images ?? []).map(url => ({ url, state: 'done' })))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // the wizard is the app's longest modal — lock the page behind it so a
  // touch drag on the dimmed backdrop can't scroll the marketplace away
  useBodyScrollLock()

  const myCollege = colleges.find(c => c.id === myCollegeId)

  const set = <K extends keyof mk.ListingInput>(key: K, value: mk.ListingInput[K]) =>
    setInput(prev => ({ ...prev, [key]: value }))

  const stepValid = (): string | null => {
    const value = input
    if (step === 0) {
      if (value.title.trim().length < 3) return 'Give the item a title of at least 3 characters.'
      if (value.description.trim().length < 10) return 'Add a full description so people know what to expect.'
      if (value.txType !== 'wanted' && !value.condition) return 'Pick the item condition.'
      if (value.txType !== 'exchange' && value.txType !== 'wanted' && !(value.quantity >= 1)) return 'Quantity must be at least 1.'
    }
    if (step === 1) {
      if (value.txType === 'for_sale' && (value.price == null || value.price < 0)) return 'Add an asking price (0 or more).'
      if (value.txType === 'free' && value.price != null) return 'Free listings cannot carry a price.'
      if (value.txType === 'exchange' && (value.exchangeFor ?? '').trim().length < 3) return 'Describe what you would accept in exchange.'
      if (value.txType === 'wanted' && value.budgetMax != null && value.budgetMax < 0) return 'Budgets cannot be negative.'
    }
    return null
  }

  const next = () => {
    const problem = stepValid()
    if (problem) { setError(problem); return }
    setError(null)
    setStep(s => Math.min(s + 1, STEPS.length - 1))
  }

  const back = () => { setError(null); setStep(s => Math.max(s - 1, 0)) }

  const addFiles = async (files: FileList | null) => {
    if (!files || !identity) return
    const room = MAX_IMAGES - photos.filter(p => p.state !== 'error').length
    const accepted = Array.from(files).slice(0, room)
    for (const file of accepted) {
      if (!file.type.startsWith('image/')) {
        setPhotos(prev => [...prev, { url: '', state: 'error', message: `"${file.name}" is not an image file.` }])
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setPhotos(prev => [...prev, { url: '', state: 'error', message: `"${file.name}" is over 5 MB — please use a smaller image.` }])
        continue
      }
      const photo: Photo = { url: '', state: 'uploading' }
      setPhotos(prev => [...prev, photo])
      try {
        const url = await db.uploadMedia(identity.id, file)
        setPhotos(prev => prev.map(p => (p === photo ? { url, state: 'done' } : p)))
      } catch (err) {
        setPhotos(prev => prev.map(p => (p === photo
          ? { ...p, state: 'error', message: err instanceof Error ? err.message : 'Upload failed — try again.' }
          : p)))
      }
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  const movePhoto = (index: number, dir: -1 | 1) => {
    setPhotos(prev => {
      const nextPhotos = [...prev]
      const target = index + dir
      if (target < 0 || target >= nextPhotos.length) return prev
      ;[nextPhotos[index], nextPhotos[target]] = [nextPhotos[target], nextPhotos[index]]
      return nextPhotos
    })
  }

  const removePhoto = (index: number) => setPhotos(prev => prev.filter((_, i) => i !== index))

  const donePhotos = () => photos.filter(p => p.state === 'done').map(p => p.url)
  const uploadPending = () => photos.some(p => p.state === 'uploading' || p.state === 'error')

  const save = async (asDraft: boolean) => {
    if (!identity) return
    setBusy(true)
    setError(null)
    try {
      const payload: mk.ListingInput = {
        ...input,
        brand: input.brand?.trim() || null,
        model: input.model?.trim() || null,
        exchangeFor: input.txType === 'exchange' ? input.exchangeFor?.trim() || null : null,
        budgetMax: input.txType === 'wanted' ? input.budgetMax : null,
        price: input.txType === 'for_sale' ? input.price : null,
        handoverSpot: input.handover === 'mutual' ? null : input.handoverSpot?.trim() || null,
        images: donePhotos(),
      }
      const slug = editing
        ? (await mk.updateListing(editing.id, payload), editing.slug)
        : await mk.createListing(payload, asDraft)
      notify(editing ? 'Changes saved.' : asDraft ? 'Draft saved — publish it from My Listings.' : 'Your listing is live.')
      onSaved(slug)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The listing could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  if (!identity || !configured) {
    return (
      <div className="modal-backdrop">
        <div className="wizard">
          <div className="wizard-body">
            <p className="mk-honesty">Sign in to list an item on the marketplace.</p>
          </div>
          <footer className="wizard-foot">
            <button className="ghost-button" onClick={onClose}>Close</button>
          </footer>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop">
      <div className="wizard">
        <header className="wizard-head">
          <div>
            <h2>{editing ? 'Edit listing' : 'Sell an Item'}</h2>
            <p>Step {step + 1} of {STEPS.length} — {STEPS[step]}</p>
          </div>
          <button className="text-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        <div className="wizard-track" aria-hidden>
          {STEPS.map((s, i) => <span key={s} className={i <= step ? 'on' : ''} />)}
        </div>

        <div className="wizard-body">
          {error && <div className="mk-notice mk-notice-warn"><ShieldAlert size={15} /><span>{error}</span></div>}

          {step === 0 && (
            <div className="form-stack">
              <div className="scope-grid">
                {TYPE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`scope-card ${input.txType === opt.value ? 'on' : ''}`}
                    onClick={() => set('txType', opt.value)}
                  >
                    <b>{opt.label}</b>
                    {opt.hint}
                  </button>
                ))}
              </div>
              <label className="form-field">
                <span>Title</span>
                <input
                  type="text"
                  value={input.title}
                  maxLength={120}
                  onChange={e => set('title', e.target.value)}
                  placeholder="e.g. Engineering Mathematics textbook, 3rd edition"
                />
              </label>
              <label className="form-field">
                <span>Description</span>
                <textarea
                  value={input.description}
                  rows={4}
                  onChange={e => set('description', e.target.value)}
                  placeholder="Condition details, reason for selling, what is included…"
                />
              </label>
              <div className="form-two">
                <label className="form-field">
                  <span>Category</span>
                  <select value={input.category} onChange={e => set('category', e.target.value)}>
                    {mk.MARKET_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                {input.txType !== 'wanted' && (
                  <label className="form-field">
                    <span>Condition</span>
                    <select
                      value={input.condition ?? ''}
                      onChange={e => set('condition', e.target.value as mk.ListingCondition)}
                    >
                      {Object.entries(mk.CONDITION_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <div className="form-two">
                <label className="form-field">
                  <span>Brand (optional)</span>
                  <input type="text" value={input.brand ?? ''} maxLength={60} onChange={e => set('brand', e.target.value)} placeholder="e.g. Casio" />
                </label>
                <label className="form-field">
                  <span>Model (optional)</span>
                  <input type="text" value={input.model ?? ''} maxLength={60} onChange={e => set('model', e.target.value)} placeholder="e.g. FX-991ES Plus" />
                </label>
              </div>
              {input.txType !== 'exchange' && input.txType !== 'wanted' && (
                <label className="form-field">
                  <span>Quantity</span>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={input.quantity}
                    onChange={e => set('quantity', Math.max(1, Math.min(999, Number(e.target.value) || 1)))}
                  />
                </label>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="form-stack">
              {input.txType === 'for_sale' && (
                <>
                  <label className="form-field">
                    <span>Asking price (₹)</span>
                    <input
                      type="number"
                      min={0}
                      value={input.price ?? ''}
                      onChange={e => set('price', e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
                      placeholder="e.g. 450"
                    />
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={input.negotiable}
                      onChange={e => set('negotiable', e.target.checked)}
                    />
                    <span>Price is negotiable — say so honestly and negotiate in chat.</span>
                  </label>
                </>
              )}
              {input.txType === 'free' && (
                <p className="mk-honesty">
                  This will show as <b>Free</b> — no price, no payment. CAMPUS does not handle money:
                  agree any costs (like shipping) directly with the receiver.
                </p>
              )}
              {input.txType === 'exchange' && (
                <>
                  <label className="form-field">
                    <span>What do you want in exchange?</span>
                    <textarea
                      value={input.exchangeFor ?? ''}
                      rows={3}
                      maxLength={500}
                      onChange={e => set('exchangeFor', e.target.value)}
                      placeholder="e.g. A scientific calculator, or headphones in good condition"
                    />
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={input.exchangeCash}
                      onChange={e => set('exchangeCash', e.target.checked)}
                    />
                    <span>Plus a cash difference if the values do not match.</span>
                  </label>
                </>
              )}
              {input.txType === 'wanted' && (
                <>
                  <label className="form-field">
                    <span>Budget up to (₹, optional)</span>
                    <input
                      type="number"
                      min={0}
                      value={input.budgetMax ?? ''}
                      onChange={e => set('budgetMax', e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
                      placeholder="e.g. 800"
                    />
                  </label>
                  <p className="mk-honesty">Describe the item you are looking for in the description above — budget is optional.</p>
                </>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="form-stack">
              <p className="mk-honesty">
                Upload up to {MAX_IMAGES} images (max 5 MB each). The first photo is the cover.
                Photos are public — never upload pictures with personal documents or faces of others.
              </p>
              <div className="mk-photo-grid">
                {photos.map((p, i) => (
                  <div key={i} className={`mk-photo ${p.state}`}>
                    {p.state === 'done' && <img src={p.url} alt="" />}
                    {p.state === 'uploading' && <><Loader2 className="spin" size={18} /><span>Uploading…</span></>}
                    {p.state === 'error' && <><ShieldAlert size={16} /><span>{p.message}</span></>}
                    {p.state === 'done' && (
                      <div className="mk-photo-tools">
                        <button type="button" aria-label="Move earlier" disabled={i === 0} onClick={() => movePhoto(i, -1)}><ChevronLeft size={13} /></button>
                        <button type="button" aria-label="Move later" disabled={i === photos.length - 1} onClick={() => movePhoto(i, 1)}><ChevronRight size={13} /></button>
                        <button type="button" aria-label="Remove photo" onClick={() => removePhoto(i)}><Trash2 size={13} /></button>
                      </div>
                    )}
                    {p.state === 'error' && (
                      <div className="mk-photo-tools">
                        <button type="button" aria-label="Dismiss error" onClick={() => removePhoto(i)}><X size={13} /></button>
                      </div>
                    )}
                  </div>
                ))}
                {photos.length < MAX_IMAGES && (
                  <button type="button" className="mk-photo-add" onClick={() => fileRef.current?.click()}>
                    <ImagePlus size={18} /><span>Add photo</span>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={e => void addFiles(e.target.files)}
                    />
                  </button>
                )}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="form-stack">
              <p className="mk-honesty">
                Choose who can discover this listing. Your college affiliation is always your
                self-declared profile college — audience and affiliation are separate choices.
              </p>
              <div className="scope-grid">
                <button
                  type="button"
                  className={`scope-card ${input.audience === 'college' ? 'on' : ''}`}
                  onClick={() => set('audience', 'college')}
                >
                  <b><Building2 size={13} /> My college</b>
                  Visible to students of {myCollege?.name ?? 'your college'} only.
                </button>
                <button
                  type="button"
                  className={`scope-card ${input.audience === 'global' ? 'on' : ''}`}
                  onClick={() => set('audience', 'global')}
                >
                  <b><Globe2 size={13} /> All colleges</b>
                  Any signed-in CAMPUS student can discover it.
                </button>
              </div>
              <p className="form-note">
                <Building2 size={13} />
                <span>
                  {myCollege
                    ? <>Your listing will be tagged with <b>{myCollege.name}</b> (from your profile).</>
                    : <>You have not set a college on your profile — choose “All colleges” or set your college first.</>}
                </span>
              </p>
            </div>
          )}

          {step === 4 && (
            <div className="form-stack">
              <p className="mk-honesty">How can the item change hands? Never share your home address — agree the exact spot in chat.</p>
              <div className="scope-grid">
                {(Object.entries(mk.HANDOVER_LABELS) as [mk.ListingHandover, string][]).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`scope-card ${input.handover === value ? 'on' : ''}`}
                    onClick={() => set('handover', value)}
                  >
                    <b>{label}</b>
                  </button>
                ))}
              </div>
              {input.handover !== 'mutual' && (
                <label className="form-field">
                  <span>Meetup hint (optional, public)</span>
                  <input
                    type="text"
                    value={input.handoverSpot ?? ''}
                    maxLength={160}
                    onChange={e => set('handoverSpot', e.target.value)}
                    placeholder="e.g. Main library entrance, Hostel B common room"
                  />
                </label>
              )}
            </div>
          )}

          {step === 5 && (
            <div className="form-stack review-stack">
              <h3 className="review-title">{input.title || 'Untitled listing'}</h3>
              <p className="review-line"><Package size={14} /><span>{mk.TX_LABELS[input.txType]} · {input.category}{input.condition ? ` · ${mk.CONDITION_LABELS[input.condition]}` : ''}</span></p>
              <p className="review-line"><b>{mk.priceLine({ transactionType: input.txType, price: input.price, budgetMax: input.budgetMax, negotiable: input.negotiable, exchangeFor: input.exchangeFor })}</b></p>
              <p className="review-line">
                <Building2 size={14} />
                <span>{input.audience === 'global' ? 'Visible to all colleges' : `Visible to ${myCollege?.name ?? 'your college'}`}</span>
              </p>
              <p className="review-line"><BadgeCheck size={14} /><span>{mk.HANDOVER_LABELS[input.handover]}{input.handoverSpot ? ` — ${input.handoverSpot}` : ''}</span></p>
              <p className="review-line"><ImagePlus size={14} /><span>{donePhotos().length} photo{donePhotos().length === 1 ? '' : 's'}</span></p>
              {uploadPending() && (
                <p className="review-line warn-line">
                  <ShieldAlert size={14} />
                  <span>Some photos are still uploading or failed — only uploaded photos are kept.</span>
                </p>
              )}
              <p className="mk-honesty">
                Prohibited items are not allowed: no illegal goods, stolen or counterfeit items, weapons,
                drugs, alcohol, nicotine, or academic cheating services. Listings that break the rules are
                removed by moderators.
              </p>
              {editing && (
                <p className="form-note"><RotateCcw size={13} /><span>Saving updates the live listing immediately.</span></p>
              )}
            </div>
          )}
        </div>

        <footer className="wizard-foot">
          {step > 0
            ? <button className="ghost-button" onClick={back}><ArrowLeft size={14} /> Back</button>
            : <button className="ghost-button" onClick={onClose}>Cancel</button>}
          <div className="wizard-actions-group">
            {step < STEPS.length - 1 && (
              <button className="primary-button" onClick={next}>Continue <ArrowRight size={14} /></button>
            )}
            {step === STEPS.length - 1 && (
              <>
                {!editing && (
                  <button className="ghost-button" disabled={busy || uploadPending()} onClick={() => void save(true)}>
                    Save draft
                  </button>
                )}
                <button className="primary-button" disabled={busy || uploadPending()} onClick={() => void save(false)}>
                  {busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
                  {editing ? 'Save changes' : 'Publish listing'}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
