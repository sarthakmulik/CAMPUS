import { supabase } from './supabase'
import { friendlyMessage } from './db'

/**
 * Typed data access for Marketplace (migration 0019).
 *
 * Every mutation with authority behind it goes through a security-definer RPC
 * (direct writes are denied at the row level). The only "popularity" signal
 * marketplace uses is saved_listings, maintained by a trigger — nothing is
 * fabricated. Prices are Indian Rupees; one formatter for the whole app.
 */

/** Single source of truth for categories — mirrors the CHECK in 0019. */
export const MARKET_CATEGORIES = [
  'Books & Study Materials',
  'Electronics',
  'Engineering & Lab Equipment',
  'Hostel & Room Essentials',
  'Cycles & Mobility',
  'Fashion & Accessories',
  'Sports & Fitness',
  'Art & Creativity',
  'Furniture',
  'Free & Exchange',
  'Other',
] as const

export type ListingTxType = 'for_sale' | 'free' | 'exchange' | 'wanted'
export type ListingCondition = 'new' | 'like_new' | 'good' | 'fair' | 'parts'
export type ListingAudience = 'college' | 'global'
export type ListingHandover = 'campus_meetup' | 'public_spot' | 'pickup' | 'mutual'
export type ListingStatus = 'draft' | 'active' | 'reserved' | 'sold' | 'archived'
export type ListingMode = 'discover' | 'global' | 'mycollege' | 'mine' | 'saved'
export type ListingSort = 'recommended' | 'new' | 'price_asc' | 'price_desc' | 'saved'
export type ListingScope = 'all' | 'mine_only' | 'beyond'

export interface ListingInput {
  title: string
  description: string
  category: string
  txType: ListingTxType
  condition: ListingCondition | null
  brand: string | null
  model: string | null
  quantity: number
  price: number | null
  negotiable: boolean
  budgetMax: number | null
  exchangeFor: string | null
  exchangeCash: boolean
  images: string[]
  audience: ListingAudience
  handover: ListingHandover
  handoverSpot: string | null
}

export interface ListingSummary {
  id: string
  slug: string
  title: string
  descriptionLead: string | null
  category: string
  transactionType: ListingTxType
  condition: ListingCondition | null
  brand: string | null
  model: string | null
  quantity: number
  price: number | string | null
  negotiable: boolean
  budgetMax: number | string | null
  exchangeFor: string | null
  images: string[]
  collegeName: string | null
  audience: ListingAudience
  handover: ListingHandover
  status: ListingStatus
  moderationStatus: 'clean' | 'removed'
  savedCount: number
  savedByMe: boolean
  isMine: boolean
  ownerId: string
  ownerName: string | null
  ownerUsername: string
  ownerAvatar: string | null
  ownerVerified: boolean
  ownerCollege: string | null
  createdAt: string
  updatedAt: string
}

export interface ListingDetail extends Omit<ListingSummary, 'descriptionLead'> {
  description: string
  exchangeCash: boolean
  collegeId: string | null
  handoverSpot: string | null
  removedReason: string | null
  publishedAt: string | null
}

const CONDITION_LABELS: Record<ListingCondition, string> = {
  new: 'New',
  like_new: 'Like new',
  good: 'Good',
  fair: 'Fair',
  parts: 'For parts or repair',
}

export const TX_LABELS: Record<ListingTxType, string> = {
  for_sale: 'For sale',
  free: 'Free',
  exchange: 'Exchange',
  wanted: 'Wanted',
}

export const HANDOVER_LABELS: Record<ListingHandover, string> = {
  campus_meetup: 'Meet on campus',
  public_spot: 'Public meetup location',
  pickup: 'Buyer picks up',
  mutual: 'Other mutual arrangement',
}

export const STATUS_LABELS: Record<ListingStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  reserved: 'Reserved',
  sold: 'Sold',
  archived: 'Archived',
}

export const STATUS_CHIP_CLASSES: Record<ListingStatus, string> = {
  draft: 'mk-chip mk-chip-draft',
  active: 'mk-chip mk-chip-active',
  reserved: 'mk-chip mk-chip-reserved',
  sold: 'mk-chip mk-chip-sold',
  archived: 'mk-chip mk-chip-archived',
}

/** The one INR formatter — no hardcoded currency strings anywhere else. */
const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

export function formatInr(value: number | string | null): string | null {
  if (value === null || value === '') return null
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(n)) return null
  return inr.format(n)
}

/** Human price line for a listing card/detail — honest about type. An exchange
 * "want" can run to 500 characters, so call sites may cap the line; the detail
 * page keeps the full text, cards use a short one. */
export function priceLine(
  row: Pick<ListingSummary, 'transactionType' | 'price' | 'budgetMax' | 'negotiable' | 'exchangeFor'>,
  maxLength?: number,
): string {
  let line: string
  if (row.transactionType === 'free') line = 'Free'
  else if (row.transactionType === 'exchange') {
    line = row.exchangeFor ? `Exchange — wants ${row.exchangeFor}` : 'Exchange'
  } else if (row.transactionType === 'wanted') {
    const budget = formatInr(row.budgetMax)
    line = budget ? `Wanted — up to ${budget}` : 'Wanted'
  } else {
    const price = formatInr(row.price)
    line = !price ? 'Price on request' : row.negotiable ? `${price} · negotiable` : price
  }
  if (maxLength != null && line.length > maxLength) {
    line = `${line.slice(0, maxLength - 1).trimEnd()}…`
  }
  return line
}

export interface ListParams {
  mode?: ListingMode
  query?: string
  category?: string | null
  txType?: ListingTxType | null
  condition?: ListingCondition | null
  minPrice?: number | null
  maxPrice?: number | null
  college?: string | null
  scope?: ListingScope
  sort?: ListingSort
  status?: ListingStatus | 'all'
  limit?: number
  offset?: number
}

export async function listListings(params: ListParams = {}): Promise<ListingSummary[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_listings', {
    p_mode: params.mode ?? 'discover',
    p_query: params.query || null,
    p_category: params.category || null,
    p_tx_type: params.txType ?? null,
    p_condition: params.condition ?? null,
    p_min_price: params.minPrice ?? null,
    p_max_price: params.maxPrice ?? null,
    p_college: params.college ?? null,
    p_scope: params.scope ?? 'all',
    p_sort: params.sort ?? 'recommended',
    p_status: params.status ?? 'all',
    p_limit: params.limit ?? 24,
    p_offset: params.offset ?? 0,
  })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as Record<string, unknown>[]).map(mapSummary)
}

function mapSummary(row: Record<string, unknown>): ListingSummary {
  return {
    id: row.id as string,
    slug: row.slug as string,
    title: row.title as string,
    descriptionLead: row.description_lead as string | null,
    category: row.category as string,
    transactionType: row.transaction_type as ListingTxType,
    condition: (row.condition as ListingCondition | null) ?? null,
    brand: (row.brand as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    quantity: Number(row.quantity ?? 1),
    price: (row.price as number | string | null) ?? null,
    negotiable: Boolean(row.negotiable),
    budgetMax: (row.budget_max as number | string | null) ?? null,
    exchangeFor: (row.exchange_for as string | null) ?? null,
    images: (row.images as string[] | null) ?? [],
    collegeName: (row.college_name as string | null) ?? null,
    audience: row.audience as ListingAudience,
    handover: row.handover as ListingHandover,
    status: row.status as ListingStatus,
    moderationStatus: row.moderation_status === 'removed' ? 'removed' : 'clean',
    savedCount: Number(row.saved_count ?? 0),
    savedByMe: Boolean(row.saved_by_me),
    isMine: Boolean(row.is_mine),
    ownerId: row.owner_id as string,
    ownerName: (row.owner_name as string | null) ?? null,
    ownerUsername: (row.owner_username as string) ?? '',
    ownerAvatar: (row.owner_avatar as string | null) ?? null,
    ownerVerified: Boolean(row.owner_verified),
    ownerCollege: (row.owner_college as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listingDetail(slug: string): Promise<ListingDetail | null> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('listing_detail', { p_slug: slug })
  if (error) throw new Error(friendlyMessage(error))
  const row = (data as Record<string, unknown>[] | null)?.[0]
  if (!row) return null
  return {
    ...mapSummary(row),
    description: row.description as string,
    exchangeCash: Boolean(row.exchange_cash),
    collegeId: (row.college_id as string | null) ?? null,
    handoverSpot: (row.handover_spot as string | null) ?? null,
    removedReason: (row.removed_reason as string | null) ?? null,
    publishedAt: (row.published_at as string | null) ?? null,
  }
}

export async function createListing(input: ListingInput, asDraft = false): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('create_listing', {
    p_title: input.title,
    p_description: input.description,
    p_category: input.category,
    p_tx_type: input.txType,
    p_condition: input.condition,
    p_brand: input.brand || null,
    p_model: input.model || null,
    p_quantity: input.quantity,
    p_price: input.price,
    p_negotiable: input.negotiable,
    p_budget_max: input.budgetMax,
    p_exchange_for: input.exchangeFor,
    p_exchange_cash: input.exchangeCash,
    p_images: input.images,
    p_audience: input.audience,
    p_handover: input.handover,
    p_handover_spot: input.handoverSpot || null,
    p_status: asDraft ? 'draft' : 'active',
  })
  if (error) throw new Error(friendlyMessage(error))
  return data as string
}

export async function updateListing(id: string, input: ListingInput): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('update_listing', {
    p_id: id,
    p_title: input.title,
    p_description: input.description,
    p_category: input.category,
    p_tx_type: input.txType,
    p_condition: input.condition,
    p_brand: input.brand || null,
    p_model: input.model || null,
    p_quantity: input.quantity,
    p_price: input.price,
    p_negotiable: input.negotiable,
    p_budget_max: input.budgetMax,
    p_exchange_for: input.exchangeFor,
    p_exchange_cash: input.exchangeCash,
    p_images: input.images,
    p_audience: input.audience,
    p_handover: input.handover,
    p_handover_spot: input.handoverSpot || null,
  })
  if (error) throw new Error(friendlyMessage(error))
}

export async function setListingStatus(id: string, status: ListingStatus): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('set_listing_status', { p_id: id, p_status: status })
  if (error) throw new Error(friendlyMessage(error))
}

export async function deleteListing(id: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('delete_listing', { p_id: id })
  if (error) throw new Error(friendlyMessage(error))
}

/** Returns the new saved state: true = now saved. */
export async function toggleSavedListing(id: string): Promise<boolean> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('toggle_saved_listing', { p_listing: id })
  if (error) throw new Error(friendlyMessage(error))
  return data === true
}

export async function reportListing(id: string, reason: string, details?: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('report_listing', {
    p_listing: id,
    p_reason: reason,
    p_details: details || null,
  })
  if (error) throw new Error(friendlyMessage(error))
}

export const REPORT_REASONS = [
  'Prohibited or illegal item',
  'Suspected stolen or counterfeit goods',
  'Academic cheating or services',
  'Weapons, drugs, alcohol or nicotine',
  'Wrong category or spam',
  'Scam or misleading details',
  'Offensive or abusive content',
  'Other',
] as const

export { CONDITION_LABELS }
