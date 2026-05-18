export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      coffrets: {
        Row: {
          created_at: string
          id: string
          name: string
          nb_par_palette: number
          poids_coffret: number
          poids_palette: number
          reference: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          nb_par_palette?: number
          poids_coffret?: number
          poids_palette?: number
          reference: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          nb_par_palette?: number
          poids_coffret?: number
          poids_palette?: number
          reference?: string
          updated_at?: string
        }
        Relationships: []
      }
      composants: {
        Row: {
          created_at: string
          id: string
          min_stock: number
          name: string
          poids_unitaire: number
          reference: string
          stock: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          min_stock?: number
          name: string
          poids_unitaire?: number
          reference: string
          stock?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          min_stock?: number
          name?: string
          poids_unitaire?: number
          reference?: string
          stock?: number
          updated_at?: string
        }
        Relationships: []
      }
      livraison_items: {
        Row: {
          coffret_id: string
          id: string
          livraison_id: string
          palettes: number
          poids: number
          quantity: number
        }
        Insert: {
          coffret_id: string
          id?: string
          livraison_id: string
          palettes?: number
          poids?: number
          quantity: number
        }
        Update: {
          coffret_id?: string
          id?: string
          livraison_id?: string
          palettes?: number
          poids?: number
          quantity?: number
        }
        Relationships: [
          {
            foreignKeyName: "livraison_items_coffret_id_fkey"
            columns: ["coffret_id"]
            isOneToOne: false
            referencedRelation: "coffrets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "livraison_items_livraison_id_fkey"
            columns: ["livraison_id"]
            isOneToOne: false
            referencedRelation: "livraisons"
            referencedColumns: ["id"]
          },
        ]
      }
      livraisons: {
        Row: {
          adresse: string
          client: string
          created_at: string
          date: string
          id: string
          reference: string
          signature: string | null
          total_palette: number
          total_poids: number
        }
        Insert: {
          adresse: string
          client: string
          created_at?: string
          date?: string
          id?: string
          reference?: string
          signature?: string | null
          total_palette?: number
          total_poids?: number
        }
        Update: {
          adresse?: string
          client?: string
          created_at?: string
          date?: string
          id?: string
          reference?: string
          signature?: string | null
          total_palette?: number
          total_poids?: number
        }
        Relationships: []
      }
      mouvements: {
        Row: {
          composant_id: string
          created_at: string
          id: string
          production_order_id: string | null
          quantity: number
          reason: string | null
          type: Database["public"]["Enums"]["mouvement_type"]
        }
        Insert: {
          composant_id: string
          created_at?: string
          id?: string
          production_order_id?: string | null
          quantity: number
          reason?: string | null
          type: Database["public"]["Enums"]["mouvement_type"]
        }
        Update: {
          composant_id?: string
          created_at?: string
          id?: string
          production_order_id?: string | null
          quantity?: number
          reason?: string | null
          type?: Database["public"]["Enums"]["mouvement_type"]
        }
        Relationships: [
          {
            foreignKeyName: "mouvements_composant_id_fkey"
            columns: ["composant_id"]
            isOneToOne: false
            referencedRelation: "composants"
            referencedColumns: ["id"]
          },
        ]
      }
      nomenclatures: {
        Row: {
          coffret_id: string
          composant_id: string
          created_at: string
          id: string
          quantity: number
        }
        Insert: {
          coffret_id: string
          composant_id: string
          created_at?: string
          id?: string
          quantity: number
        }
        Update: {
          coffret_id?: string
          composant_id?: string
          created_at?: string
          id?: string
          quantity?: number
        }
        Relationships: [
          {
            foreignKeyName: "nomenclatures_coffret_id_fkey"
            columns: ["coffret_id"]
            isOneToOne: false
            referencedRelation: "coffrets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nomenclatures_composant_id_fkey"
            columns: ["composant_id"]
            isOneToOne: false
            referencedRelation: "composants"
            referencedColumns: ["id"]
          },
        ]
      }
      production_orders: {
        Row: {
          coffret_id: string
          created_at: string
          done_at: string | null
          id: string
          notes: string | null
          quantity: number
          reference: string
          status: Database["public"]["Enums"]["production_status"]
          updated_at: string
        }
        Insert: {
          coffret_id: string
          created_at?: string
          done_at?: string | null
          id?: string
          notes?: string | null
          quantity: number
          reference?: string
          status?: Database["public"]["Enums"]["production_status"]
          updated_at?: string
        }
        Update: {
          coffret_id?: string
          created_at?: string
          done_at?: string | null
          id?: string
          notes?: string | null
          quantity?: number
          reference?: string
          status?: Database["public"]["Enums"]["production_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "production_orders_coffret_id_fkey"
            columns: ["coffret_id"]
            isOneToOne: false
            referencedRelation: "coffrets"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_stock_snapshot_by_components: {
        Args: { component_ids: string[] }
        Returns: { composant_id: string; available_stock: number }[]
      }
      record_stock_movement: {
        Args: {
          p_composant_id: string
          p_type: Database["public"]["Enums"]["mouvement_type"]
          p_quantity: number
          p_reason?: string | null
          p_entity_type?: string | null
          p_reference_id?: string | null
        }
        Returns: Json
      }
      simulate_production: {
        Args: { p_coffret_id: string; p_quantity: number }
        Returns: Json
      }
      validate_production_order: { Args: { p_order_id: string }; Returns: Json }
    }
  Enums: {
  mouvement_type: "IN" | "OUT"
  production_status:
    | "draft"
    | "ready"
    | "in_progress"
    | "paused"
    | "done"
    | "cancelled"
}
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      mouvement_type: ["IN", "OUT"],
      production_status: ["draft", "in_progress", "done", "priority"],
    },
  },
} as const
