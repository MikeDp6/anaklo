
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "appointment_events": {
                  Row: {
                    "actor_id": string | null,"actor_type": string,"appointment_id": string,"business_id": string,"event": string,"from_status": string | null,"id": number,"new_staff_id": string | null,"new_starts_at": string | null,"occurred_at": string,"old_staff_id": string | null,"old_starts_at": string | null,"to_status": string | null
                  }
                  Insert: {
                    "actor_id"?: string | null,"actor_type": string,"appointment_id": string,"business_id": string,"event": string,"from_status"?: string | null,"id"?: never,"new_staff_id"?: string | null,"new_starts_at"?: string | null,"occurred_at"?: string,"old_staff_id"?: string | null,"old_starts_at"?: string | null,"to_status"?: string | null
                  }
                  Update: {
                    "actor_id"?: string | null,"actor_type"?: string,"appointment_id"?: string,"business_id"?: string,"event"?: string,"from_status"?: string | null,"id"?: never,"new_staff_id"?: string | null,"new_starts_at"?: string | null,"occurred_at"?: string,"old_staff_id"?: string | null,"old_starts_at"?: string | null,"to_status"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "appointment_events_appointment_fk"
      columns: ["business_id","appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["business_id","id"]
    },{
      foreignKeyName: "appointment_events_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"appointment_services": {
                  Row: {
                    "appointment_id": string,"business_id": string,"duration_min": number,"position": number,"price_cents": number,"service_id": string
                  }
                  Insert: {
                    "appointment_id": string,"business_id": string,"duration_min": number,"position": number,"price_cents": number,"service_id": string
                  }
                  Update: {
                    "appointment_id"?: string,"business_id"?: string,"duration_min"?: number,"position"?: number,"price_cents"?: number,"service_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "appointment_services_appointment_fk"
      columns: ["business_id","appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["business_id","id"]
    },{
      foreignKeyName: "appointment_services_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "appointment_services_service_fk"
      columns: ["business_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["business_id","id"]
    }
                  ]
                },"appointments": {
                  Row: {
                    "buffer_after_min": number,"business_id": string,"cancel_reason": string | null,"cancelled_by": string | null,"charged_cents": number | null,"client_id": string | null,"created_at": string,"created_by": string | null,"ends_at": string,"external_ref": string | null,"id": string,"idempotency_key": string | null,"referrer": string | null,"request_hash": string | null,"source": string,"staff_id": string,"starts_at": string,"status": string,"total_cents": number,"verified_via": string | null
                  }
                  Insert: {
                    "buffer_after_min"?: number,"business_id": string,"cancel_reason"?: string | null,"cancelled_by"?: string | null,"charged_cents"?: number | null,"client_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"ends_at": string,"external_ref"?: string | null,"id"?: string,"idempotency_key"?: string | null,"referrer"?: string | null,"request_hash"?: string | null,"source": string,"staff_id": string,"starts_at": string,"status"?: string,"total_cents"?: number,"verified_via"?: string | null
                  }
                  Update: {
                    "buffer_after_min"?: number,"business_id"?: string,"cancel_reason"?: string | null,"cancelled_by"?: string | null,"charged_cents"?: number | null,"client_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"ends_at"?: string,"external_ref"?: string | null,"id"?: string,"idempotency_key"?: string | null,"referrer"?: string | null,"request_hash"?: string | null,"source"?: string,"staff_id"?: string,"starts_at"?: string,"status"?: string,"total_cents"?: number,"verified_via"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "appointments_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "appointments_client_fk"
      columns: ["business_id","client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["business_id","id"]
    },{
      foreignKeyName: "appointments_staff_fk"
      columns: ["business_id","staff_id"]
isOneToOne: false
      referencedRelation: "staff"
      referencedColumns: ["business_id","id"]
    }
                  ]
                },"audit_log": {
                  Row: {
                    "action": string,"actor_id": string | null,"actor_type": string,"at": string,"business_id": string,"entity": string,"entity_id": string | null,"id": number,"reason": string | null
                  }
                  Insert: {
                    "action": string,"actor_id"?: string | null,"actor_type": string,"at"?: string,"business_id": string,"entity": string,"entity_id"?: string | null,"id"?: never,"reason"?: string | null
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"actor_type"?: string,"at"?: string,"business_id"?: string,"entity"?: string,"entity_id"?: string | null,"id"?: never,"reason"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "audit_log_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"booking_tokens": {
                  Row: {
                    "appointment_id": string,"business_id": string,"created_at": string,"expires_at": string,"id": string,"issued_for": string,"revoked_at": string | null,"token_hash": string
                  }
                  Insert: {
                    "appointment_id": string,"business_id": string,"created_at"?: string,"expires_at": string,"id"?: string,"issued_for": string,"revoked_at"?: string | null,"token_hash": string
                  }
                  Update: {
                    "appointment_id"?: string,"business_id"?: string,"created_at"?: string,"expires_at"?: string,"id"?: string,"issued_for"?: string,"revoked_at"?: string | null,"token_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "booking_tokens_appointment_fk"
      columns: ["business_id","appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["business_id","id"]
    },{
      foreignKeyName: "booking_tokens_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"business_members": {
                  Row: {
                    "business_id": string,"created_at": string,"role": string,"staff_id": string | null,"user_id": string
                  }
                  Insert: {
                    "business_id": string,"created_at"?: string,"role": string,"staff_id"?: string | null,"user_id": string
                  }
                  Update: {
                    "business_id"?: string,"created_at"?: string,"role"?: string,"staff_id"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "business_members_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "business_members_staff_fk"
      columns: ["business_id","staff_id"]
isOneToOne: false
      referencedRelation: "staff"
      referencedColumns: ["business_id","id"]
    }
                  ]
                },"business_slug_aliases": {
                  Row: {
                    "business_id": string,"created_at": string,"slug": string
                  }
                  Insert: {
                    "business_id": string,"created_at"?: string,"slug": string
                  }
                  Update: {
                    "business_id"?: string,"created_at"?: string,"slug"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "business_slug_aliases_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"businesses": {
                  Row: {
                    "address": string | null,"allow_any_staff": boolean,"auto_complete_after_min": number,"booking_enabled": boolean,"cancel_min_notice_min": number,"correction_window_days": number,"created_at": string,"currency": string,"id": string,"import_reminders": boolean,"locale": string,"maps_url": string | null,"max_advance_days": number,"messaging_enabled": boolean,"min_notice_min": number,"name": string,"phone_e164": string | null,"quiet_end": string,"quiet_start": string,"reminder_mode": string,"settings": NonNullable<Json>,"short_code": string,"slot_step_min": number,"slug": string,"sms_daily_cap": number | null,"sms_monthly_budget_cents": number | null,"sms_sender_id": string | null,"theme": NonNullable<Json>,"timezone": string,"vertical": string
                  }
                  Insert: {
                    "address"?: string | null,"allow_any_staff"?: boolean,"auto_complete_after_min"?: number,"booking_enabled"?: boolean,"cancel_min_notice_min"?: number,"correction_window_days"?: number,"created_at"?: string,"currency"?: string,"id"?: string,"import_reminders"?: boolean,"locale"?: string,"maps_url"?: string | null,"max_advance_days"?: number,"messaging_enabled"?: boolean,"min_notice_min"?: number,"name": string,"phone_e164"?: string | null,"quiet_end"?: string,"quiet_start"?: string,"reminder_mode"?: string,"settings"?: NonNullable<Json>,"short_code"?: string,"slot_step_min"?: number,"slug": string,"sms_daily_cap"?: number | null,"sms_monthly_budget_cents"?: number | null,"sms_sender_id"?: string | null,"theme"?: NonNullable<Json>,"timezone": string,"vertical": string
                  }
                  Update: {
                    "address"?: string | null,"allow_any_staff"?: boolean,"auto_complete_after_min"?: number,"booking_enabled"?: boolean,"cancel_min_notice_min"?: number,"correction_window_days"?: number,"created_at"?: string,"currency"?: string,"id"?: string,"import_reminders"?: boolean,"locale"?: string,"maps_url"?: string | null,"max_advance_days"?: number,"messaging_enabled"?: boolean,"min_notice_min"?: number,"name"?: string,"phone_e164"?: string | null,"quiet_end"?: string,"quiet_start"?: string,"reminder_mode"?: string,"settings"?: NonNullable<Json>,"short_code"?: string,"slot_step_min"?: number,"slug"?: string,"sms_daily_cap"?: number | null,"sms_monthly_budget_cents"?: number | null,"sms_sender_id"?: string | null,"theme"?: NonNullable<Json>,"timezone"?: string,"vertical"?: string
                  }
                  Relationships: [
                    
                  ]
                },"client_consents": {
                  Row: {
                    "business_id": string,"client_id": string,"created_at": string,"created_by": string | null,"given_by": string,"granted": boolean,"id": string,"legal_basis": string,"policy_version": string,"purpose": string,"source": string,"withdrawn_at": string | null
                  }
                  Insert: {
                    "business_id": string,"client_id": string,"created_at"?: string,"created_by"?: string | null,"given_by"?: string,"granted": boolean,"id"?: string,"legal_basis": string,"policy_version": string,"purpose": string,"source": string,"withdrawn_at"?: string | null
                  }
                  Update: {
                    "business_id"?: string,"client_id"?: string,"created_at"?: string,"created_by"?: string | null,"given_by"?: string,"granted"?: boolean,"id"?: string,"legal_basis"?: string,"policy_version"?: string,"purpose"?: string,"source"?: string,"withdrawn_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "client_consents_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "client_consents_client_fk"
      columns: ["business_id","client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["business_id","id"]
    }
                  ]
                },"client_notes": {
                  Row: {
                    "author_id": string | null,"body": string,"business_id": string,"client_id": string,"created_at": string,"id": string
                  }
                  Insert: {
                    "author_id"?: string | null,"body": string,"business_id": string,"client_id": string,"created_at"?: string,"id"?: string
                  }
                  Update: {
                    "author_id"?: string | null,"body"?: string,"business_id"?: string,"client_id"?: string,"created_at"?: string,"id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "client_notes_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "client_notes_client_fk"
      columns: ["business_id","client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["business_id","id"]
    }
                  ]
                },"clients": {
                  Row: {
                    "birthday": string | null,"business_id": string,"created_at": string,"email": string | null,"erased_at": string | null,"external_ref": string | null,"full_name": string,"id": string,"locale": string,"merged_into_id": string | null,"phone_e164": string | null,"phone_verified_at": string | null,"search_text": string,"source": string
                  }
                  Insert: {
                    "birthday"?: string | null,"business_id": string,"created_at"?: string,"email"?: string | null,"erased_at"?: string | null,"external_ref"?: string | null,"full_name": string,"id"?: string,"locale"?: string,"merged_into_id"?: string | null,"phone_e164"?: string | null,"phone_verified_at"?: string | null,"search_text"?: string,"source": string
                  }
                  Update: {
                    "birthday"?: string | null,"business_id"?: string,"created_at"?: string,"email"?: string | null,"erased_at"?: string | null,"external_ref"?: string | null,"full_name"?: string,"id"?: string,"locale"?: string,"merged_into_id"?: string | null,"phone_e164"?: string | null,"phone_verified_at"?: string | null,"search_text"?: string,"source"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "clients_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "clients_merged_into_fk"
      columns: ["business_id","merged_into_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["business_id","id"]
    }
                  ]
                },"member_notification_prefs": {
                  Row: {
                    "business_id": string,"push_all": boolean | null,"push_own": boolean | null,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "business_id": string,"push_all"?: boolean | null,"push_own"?: boolean | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "business_id"?: string,"push_all"?: boolean | null,"push_own"?: boolean | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "member_notification_prefs_member_fk"
      columns: ["business_id","user_id"]
isOneToOne: true
      referencedRelation: "business_members"
      referencedColumns: ["business_id","user_id"]
    }
                  ]
                },"messages_log": {
                  Row: {
                    "appointment_id": string | null,"attempts": number,"booking_token_id": string | null,"business_id": string,"category": string,"channel": string,"client_id": string | null,"cost_cents": number | null,"created_at": string,"dedupe_key": string,"error": string | null,"id": string,"lease_id": string | null,"lease_until": string | null,"locale": string,"otp_challenge_id": string | null,"provider": string | null,"provider_message_id": string | null,"recipient_user_id": string | null,"scheduled_for": string,"segments": number | null,"sent_at": string | null,"status": string,"template": string,"to_e164": string | null,"updated_at": string
                  }
                  Insert: {
                    "appointment_id"?: string | null,"attempts"?: number,"booking_token_id"?: string | null,"business_id": string,"category": string,"channel": string,"client_id"?: string | null,"cost_cents"?: number | null,"created_at"?: string,"dedupe_key": string,"error"?: string | null,"id"?: string,"lease_id"?: string | null,"lease_until"?: string | null,"locale": string,"otp_challenge_id"?: string | null,"provider"?: string | null,"provider_message_id"?: string | null,"recipient_user_id"?: string | null,"scheduled_for"?: string,"segments"?: number | null,"sent_at"?: string | null,"status"?: string,"template": string,"to_e164"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "appointment_id"?: string | null,"attempts"?: number,"booking_token_id"?: string | null,"business_id"?: string,"category"?: string,"channel"?: string,"client_id"?: string | null,"cost_cents"?: number | null,"created_at"?: string,"dedupe_key"?: string,"error"?: string | null,"id"?: string,"lease_id"?: string | null,"lease_until"?: string | null,"locale"?: string,"otp_challenge_id"?: string | null,"provider"?: string | null,"provider_message_id"?: string | null,"recipient_user_id"?: string | null,"scheduled_for"?: string,"segments"?: number | null,"sent_at"?: string | null,"status"?: string,"template"?: string,"to_e164"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "messages_log_appointment_fk"
      columns: ["business_id","appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["business_id","id"]
    },{
      foreignKeyName: "messages_log_booking_token_fk"
      columns: ["business_id","booking_token_id"]
isOneToOne: false
      referencedRelation: "booking_tokens"
      referencedColumns: ["business_id","id"]
    },{
      foreignKeyName: "messages_log_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "messages_log_client_fk"
      columns: ["business_id","client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["business_id","id"]
    },{
      foreignKeyName: "messages_log_otp_challenge_fk"
      columns: ["business_id","otp_challenge_id"]
isOneToOne: false
      referencedRelation: "otp_challenges"
      referencedColumns: ["business_id","id"]
    }
                  ]
                },"otp_challenges": {
                  Row: {
                    "attempts": number,"business_id": string,"code_hmac": string,"created_at": string,"expires_at": string,"grant_appointment_id": string | null,"grant_expires_at": string | null,"grant_hash": string | null,"grant_used_at": string | null,"id": string,"phone_hmac": string | null,"verified_at": string | null
                  }
                  Insert: {
                    "attempts"?: number,"business_id": string,"code_hmac": string,"created_at"?: string,"expires_at": string,"grant_appointment_id"?: string | null,"grant_expires_at"?: string | null,"grant_hash"?: string | null,"grant_used_at"?: string | null,"id"?: string,"phone_hmac"?: string | null,"verified_at"?: string | null
                  }
                  Update: {
                    "attempts"?: number,"business_id"?: string,"code_hmac"?: string,"created_at"?: string,"expires_at"?: string,"grant_appointment_id"?: string | null,"grant_expires_at"?: string | null,"grant_hash"?: string | null,"grant_used_at"?: string | null,"id"?: string,"phone_hmac"?: string | null,"verified_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "otp_challenges_appointment_fk"
      columns: ["business_id","grant_appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["business_id","id"]
    },{
      foreignKeyName: "otp_challenges_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"push_subscriptions": {
                  Row: {
                    "auth_secret": string | null,"created_at": string,"endpoint": string | null,"id": string,"p256dh": string | null,"provider": string,"subscription_id": string | null,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "auth_secret"?: string | null,"created_at"?: string,"endpoint"?: string | null,"id"?: string,"p256dh"?: string | null,"provider": string,"subscription_id"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "auth_secret"?: string | null,"created_at"?: string,"endpoint"?: string | null,"id"?: string,"p256dh"?: string | null,"provider"?: string,"subscription_id"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"rate_limits": {
                  Row: {
                    "bucket": string,"count": number,"key": string,"window_start": string
                  }
                  Insert: {
                    "bucket": string,"count"?: number,"key": string,"window_start": string
                  }
                  Update: {
                    "bucket"?: string,"count"?: number,"key"?: string,"window_start"?: string
                  }
                  Relationships: [
                    
                  ]
                },"schedule_exceptions": {
                  Row: {
                    "business_id": string,"end_time": string | null,"id": string,"kind": string,"local_date": string,"note": string | null,"staff_id": string | null,"start_time": string | null
                  }
                  Insert: {
                    "business_id": string,"end_time"?: string | null,"id"?: string,"kind": string,"local_date": string,"note"?: string | null,"staff_id"?: string | null,"start_time"?: string | null
                  }
                  Update: {
                    "business_id"?: string,"end_time"?: string | null,"id"?: string,"kind"?: string,"local_date"?: string,"note"?: string | null,"staff_id"?: string | null,"start_time"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "schedule_exceptions_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "schedule_exceptions_staff_fk"
      columns: ["business_id","staff_id"]
isOneToOne: false
      referencedRelation: "staff"
      referencedColumns: ["business_id","id"]
    }
                  ]
                },"service_categories": {
                  Row: {
                    "business_id": string,"id": string,"name": string,"sort": number
                  }
                  Insert: {
                    "business_id": string,"id"?: string,"name": string,"sort"?: number
                  }
                  Update: {
                    "business_id"?: string,"id"?: string,"name"?: string,"sort"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "service_categories_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"services": {
                  Row: {
                    "active": boolean,"buffer_after_min": number,"business_id": string,"category_id": string | null,"created_at": string,"duration_min": number,"id": string,"name": string,"online_bookable": boolean,"price_cents": number,"sort": number
                  }
                  Insert: {
                    "active"?: boolean,"buffer_after_min"?: number,"business_id": string,"category_id"?: string | null,"created_at"?: string,"duration_min": number,"id"?: string,"name": string,"online_bookable"?: boolean,"price_cents": number,"sort"?: number
                  }
                  Update: {
                    "active"?: boolean,"buffer_after_min"?: number,"business_id"?: string,"category_id"?: string | null,"created_at"?: string,"duration_min"?: number,"id"?: string,"name"?: string,"online_bookable"?: boolean,"price_cents"?: number,"sort"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "services_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "services_category_fk"
      columns: ["business_id","category_id"]
isOneToOne: false
      referencedRelation: "service_categories"
      referencedColumns: ["business_id","id"]
    }
                  ]
                },"staff": {
                  Row: {
                    "active": boolean,"business_id": string,"color": string | null,"created_at": string,"display_name": string,"id": string,"photo_url": string | null,"sort": number
                  }
                  Insert: {
                    "active"?: boolean,"business_id": string,"color"?: string | null,"created_at"?: string,"display_name": string,"id"?: string,"photo_url"?: string | null,"sort"?: number
                  }
                  Update: {
                    "active"?: boolean,"business_id"?: string,"color"?: string | null,"created_at"?: string,"display_name"?: string,"id"?: string,"photo_url"?: string | null,"sort"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "staff_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"staff_services": {
                  Row: {
                    "business_id": string,"custom_duration_min": number | null,"custom_price_cents": number | null,"service_id": string,"staff_id": string
                  }
                  Insert: {
                    "business_id": string,"custom_duration_min"?: number | null,"custom_price_cents"?: number | null,"service_id": string,"staff_id": string
                  }
                  Update: {
                    "business_id"?: string,"custom_duration_min"?: number | null,"custom_price_cents"?: number | null,"service_id"?: string,"staff_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "staff_services_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "staff_services_service_fk"
      columns: ["business_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["business_id","id"]
    },{
      foreignKeyName: "staff_services_staff_fk"
      columns: ["business_id","staff_id"]
isOneToOne: false
      referencedRelation: "staff"
      referencedColumns: ["business_id","id"]
    }
                  ]
                },"suppression_list": {
                  Row: {
                    "business_id": string,"created_at": string,"phone_hmac": string,"reason": string
                  }
                  Insert: {
                    "business_id": string,"created_at"?: string,"phone_hmac": string,"reason": string
                  }
                  Update: {
                    "business_id"?: string,"created_at"?: string,"phone_hmac"?: string,"reason"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "suppression_list_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"time_off": {
                  Row: {
                    "business_id": string,"created_at": string,"ends_at": string,"id": string,"reason": string,"staff_id": string,"starts_at": string
                  }
                  Insert: {
                    "business_id": string,"created_at"?: string,"ends_at": string,"id"?: string,"reason"?: string,"staff_id": string,"starts_at": string
                  }
                  Update: {
                    "business_id"?: string,"created_at"?: string,"ends_at"?: string,"id"?: string,"reason"?: string,"staff_id"?: string,"starts_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "time_off_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "time_off_staff_fk"
      columns: ["business_id","staff_id"]
isOneToOne: false
      referencedRelation: "staff"
      referencedColumns: ["business_id","id"]
    }
                  ]
                },"trusted_devices": {
                  Row: {
                    "business_id": string,"created_at": string,"expires_at": string,"id": string,"phone_hmac": string,"revoked_at": string | null,"token_hash": string
                  }
                  Insert: {
                    "business_id": string,"created_at"?: string,"expires_at": string,"id"?: string,"phone_hmac": string,"revoked_at"?: string | null,"token_hash": string
                  }
                  Update: {
                    "business_id"?: string,"created_at"?: string,"expires_at"?: string,"id"?: string,"phone_hmac"?: string,"revoked_at"?: string | null,"token_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "trusted_devices_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"working_hours": {
                  Row: {
                    "business_id": string,"end_time": string,"id": string,"staff_id": string,"start_time": string,"weekday": number
                  }
                  Insert: {
                    "business_id": string,"end_time": string,"id"?: string,"staff_id": string,"start_time": string,"weekday": number
                  }
                  Update: {
                    "business_id"?: string,"end_time"?: string,"id"?: string,"staff_id"?: string,"start_time"?: string,"weekday"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "working_hours_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "working_hours_staff_fk"
      columns: ["business_id","staff_id"]
isOneToOne: false
      referencedRelation: "staff"
      referencedColumns: ["business_id","id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "add_member":
{ Args: { "p_actor_id": string,"p_business_id": string,"p_role": string,"p_staff_id": string,"p_user_id": string }; Returns: Json
                           },
"authorize_factor_change":
{ Args: { "p_action": string,"p_factor_id"?: string }; Returns: Json
                           },
"available_slots":
{ Args: { "p_from": string,"p_service_ids": (string)[],"p_slug": string,"p_staff_id": string,"p_to": string }; Returns: {
              "local_date": string,"local_time": string,"staff_ids": (string)[],"starts_at": string
            }[]
                           },
"book_appointment":
{ Args: { "p_business_id": string,"p_client_id": string,"p_grant": string,"p_idempotency_key": string,"p_marketing_box": string,"p_new_client": Json,"p_phone": string,"p_policy_version": string,"p_service_ids": (string)[],"p_staff_id": string,"p_starts_at": string,"p_trusted_device_token": string }; Returns: Json
                           },
"busy_calendar":
{ Args: { "p_business_id": string,"p_local_date": string }; Returns: Json
                           },
"can_manage_members":
{ Args: { "p_business_id": string }; Returns: boolean
                           },
"cancel_appointment":
{ Args: { "p_appointment_id": string,"p_business_id": string,"p_from_status": string,"p_notify": boolean,"p_reason": string }; Returns: Json
                           },
"change_business_identity":
{ Args: { "p_business_id": string,"p_currency"?: string,"p_slug"?: string,"p_timezone"?: string }; Returns: Json
                           },
"claim_due_messages":
{ Args: { "p_limit": number }; Returns: Json
                           },
"claim_messages":
{ Args: { "p_ids": (string)[] }; Returns: Json
                           },
"client_card":
{ Args: { "p_business_id": string,"p_client_id": string }; Returns: Json
                           },
"clients_for_phone":
{ Args: { "p_business_id": string,"p_grant": string,"p_phone": string,"p_trusted_device_token": string }; Returns: Json
                           },
"erase_client":
{ Args: { "p_business_id": string,"p_client_id": string }; Returns: Json
                           },
"list_members":
{ Args: { "p_business_id": string }; Returns: {
              "created_at": string,"email": string,"is_self": boolean,"last_sign_in_at": string,"role": string,"staff_id": string,"staff_name": string,"user_id": string
            }[]
                           },
"manage_cancel":
{ Args: { "p_token": string }; Returns: Json
                           },
"manage_reschedule":
{ Args: { "p_new_starts_at": string,"p_token": string }; Returns: Json
                           },
"manage_slots":
{ Args: { "p_from": string,"p_to": string,"p_token": string }; Returns: {
              "local_date": string,"local_time": string,"starts_at": string
            }[]
                           },
"manage_view":
{ Args: { "p_token": string }; Returns: Json
                           },
"mark_absence":
{ Args: { "p_business_id": string,"p_from": string,"p_staff_id": string,"p_to": string }; Returns: Json
                           },
"merge_clients":
{ Args: { "p_business_id": string,"p_source": string,"p_target": string }; Returns: Json
                           },
"otp_start":
{ Args: { "p_business_id": string,"p_code"?: string,"p_ip": string,"p_locale": string,"p_phone": string,"p_service_ids": (string)[],"p_staff_id": string,"p_starts_at": string }; Returns: Json
                           },
"otp_verify":
{ Args: { "p_business_id": string,"p_challenge_id": string,"p_code": string,"p_phone": string }; Returns: Json
                           },
"public_booking_catalogue":
{ Args: { "p_slug": string }; Returns: Json
                           },
"public_business_profile":
{ Args: { "p_slug": string }; Returns: {
              "locale": string,"name": string,"slug": string,"theme": Json,"timezone": string,"vertical": string
            }[]
                           },
"public_slug_for_code":
{ Args: { "p_code": string }; Returns: string
                           },
"reassign_appointment":
{ Args: { "p_appointment_id": string,"p_business_id": string,"p_expected_staff_id": string,"p_expected_starts_at": string,"p_idempotency_key": string,"p_new_staff_id": string,"p_notify": boolean }; Returns: Json
                           },
"reassign_candidates":
{ Args: { "p_appointment_id": string,"p_business_id": string }; Returns: {
              "blocker": string,"free": boolean,"staff_id": string
            }[]
                           },
"record_delivery_report":
{ Args: { "p_cost_cents": number,"p_error": string,"p_provider": string,"p_provider_message_id": string,"p_segments": number,"p_status": string }; Returns: boolean
                           },
"record_dispatch_run":
{ Args: { "p_error": string,"p_ok": boolean,"p_rows": number,"p_started_at": string }; Returns: number
                           },
"record_send_result":
{ Args: { "p_cost_cents": number,"p_error": string,"p_id": string,"p_lease_id": string,"p_outcome": string,"p_provider": string,"p_provider_message_id": string,"p_segments": number }; Returns: boolean
                           },
"record_support_action":
{ Args: { "p_action": string,"p_business_id"?: string,"p_reason": string,"p_ticket": string,"p_user_id"?: string }; Returns: Json
                           },
"register_push_subscription":
{ Args: { "p_auth"?: string,"p_endpoint"?: string,"p_p256dh"?: string,"p_provider": string,"p_subscription_id"?: string }; Returns: Json
                           },
"remove_member":
{ Args: { "p_business_id": string,"p_user_id": string }; Returns: Json
                           },
"replace_week_hours":
{ Args: { "p_business_id": string,"p_rows": Json,"p_staff_id": string }; Returns: Json
                           },
"request_test_push":
{ Args: { "p_business_id": string }; Returns: Json
                           },
"revoke_user_sessions":
{ Args: { "p_user_id": string }; Returns: Json
                           },
"save_service":
{ Args: { "p_business_id": string,"p_offers": Json,"p_service": Json,"p_service_id": string }; Returns: Json
                           },
"schedule_conflicts":
{ Args: { "p_business_id": string,"p_from"?: string,"p_staff_id"?: string,"p_to"?: string }; Returns: {
              "appointment_id": string,"client_id": string,"client_name": string,"client_phone_e164": string,"ends_at": string,"reasons": (string)[],"service_ids": (string)[],"source": string,"staff_id": string,"starts_at": string,"status": string
            }[]
                           },
"search_clients":
{ Args: { "p_business_id": string,"p_query": string }; Returns: {
              "full_name": string,"id": string,"last_visit_at": string,"phone_e164": string
            }[]
                           },
"set_appointment_status":
{ Args: { "p_appointment_id": string,"p_business_id": string,"p_from_status": string,"p_status": string }; Returns: Json
                           },
"set_client_consent":
{ Args: { "p_business_id": string,"p_client_id": string,"p_given_by"?: string,"p_granted": boolean,"p_policy_version"?: string,"p_purpose": string }; Returns: Json
                           },
"set_member_role":
{ Args: { "p_business_id": string,"p_role": string,"p_user_id": string }; Returns: Json
                           },
"set_staff_order":
{ Args: { "p_business_id": string,"p_staff_ids": (string)[] }; Returns: Json
                           },
"staff_available_slots":
{ Args: { "p_business_id": string,"p_exclude_appointment_id"?: string,"p_from": string,"p_service_ids": (string)[],"p_staff_id": string,"p_to": string }; Returns: {
              "local_date": string,"local_time": string,"staff_ids": (string)[],"starts_at": string
            }[]
                           },
"staff_book_appointment":
{ Args: { "p_allow_buffer_overlap"?: boolean,"p_allow_outside_hours"?: boolean,"p_business_id": string,"p_client_id"?: string,"p_idempotency_key"?: string,"p_new_client"?: Json,"p_service_ids": (string)[],"p_source"?: string,"p_staff_id": string,"p_starts_at": string }; Returns: Json
                           },
"staff_move_appointment":
{ Args: { "p_allow_buffer_overlap"?: boolean,"p_allow_outside_hours"?: boolean,"p_appointment_id": string,"p_business_id": string,"p_idempotency_key": string,"p_new_staff_id"?: string,"p_new_starts_at": string,"p_notify": boolean }; Returns: Json
                           },
"today_summary":
{ Args: { "p_business_id": string }; Returns: Json
                           },
"trusted_device_revoke":
{ Args: { "p_business_id": string,"p_trusted_device_token": string }; Returns: undefined
                           },
"unregister_push_subscription":
{ Args: { "p_all"?: boolean,"p_endpoint"?: string,"p_subscription_id"?: string }; Returns: number
                           },
"user_id_for_email":
{ Args: { "p_email": string }; Returns: string
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const

