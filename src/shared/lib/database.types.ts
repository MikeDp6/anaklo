
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
                    "buffer_after_min": number,"business_id": string,"cancel_reason": string | null,"cancelled_by": string | null,"charged_cents": number | null,"client_id": string | null,"created_at": string,"created_by": string | null,"ends_at": string,"external_ref": string | null,"id": string,"idempotency_key": string | null,"referrer": string | null,"source": string,"staff_id": string,"starts_at": string,"status": string,"total_cents": number,"verified_via": string | null
                  }
                  Insert: {
                    "buffer_after_min"?: number,"business_id": string,"cancel_reason"?: string | null,"cancelled_by"?: string | null,"charged_cents"?: number | null,"client_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"ends_at": string,"external_ref"?: string | null,"id"?: string,"idempotency_key"?: string | null,"referrer"?: string | null,"source": string,"staff_id": string,"starts_at": string,"status"?: string,"total_cents"?: number,"verified_via"?: string | null
                  }
                  Update: {
                    "buffer_after_min"?: number,"business_id"?: string,"cancel_reason"?: string | null,"cancelled_by"?: string | null,"charged_cents"?: number | null,"client_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"ends_at"?: string,"external_ref"?: string | null,"id"?: string,"idempotency_key"?: string | null,"referrer"?: string | null,"source"?: string,"staff_id"?: string,"starts_at"?: string,"status"?: string,"total_cents"?: number,"verified_via"?: string | null
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
                },"businesses": {
                  Row: {
                    "allow_any_staff": boolean,"auto_complete_after_min": number,"booking_enabled": boolean,"cancel_min_notice_min": number,"correction_window_days": number,"created_at": string,"currency": string,"id": string,"locale": string,"max_advance_days": number,"messaging_enabled": boolean,"min_notice_min": number,"name": string,"phone_e164": string | null,"settings": NonNullable<Json>,"slot_step_min": number,"slug": string,"theme": NonNullable<Json>,"timezone": string,"vertical": string
                  }
                  Insert: {
                    "allow_any_staff"?: boolean,"auto_complete_after_min"?: number,"booking_enabled"?: boolean,"cancel_min_notice_min"?: number,"correction_window_days"?: number,"created_at"?: string,"currency"?: string,"id"?: string,"locale"?: string,"max_advance_days"?: number,"messaging_enabled"?: boolean,"min_notice_min"?: number,"name": string,"phone_e164"?: string | null,"settings"?: NonNullable<Json>,"slot_step_min"?: number,"slug": string,"theme"?: NonNullable<Json>,"timezone": string,"vertical": string
                  }
                  Update: {
                    "allow_any_staff"?: boolean,"auto_complete_after_min"?: number,"booking_enabled"?: boolean,"cancel_min_notice_min"?: number,"correction_window_days"?: number,"created_at"?: string,"currency"?: string,"id"?: string,"locale"?: string,"max_advance_days"?: number,"messaging_enabled"?: boolean,"min_notice_min"?: number,"name"?: string,"phone_e164"?: string | null,"settings"?: NonNullable<Json>,"slot_step_min"?: number,"slug"?: string,"theme"?: NonNullable<Json>,"timezone"?: string,"vertical"?: string
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
            "public_business_profile":
{ Args: { "p_slug": string }; Returns: {
              "locale": string,"name": string,"slug": string,"theme": Json,"timezone": string,"vertical": string
            }[]
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

