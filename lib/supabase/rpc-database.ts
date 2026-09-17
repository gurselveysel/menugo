/** Minimal Data API transport types, not a replacement for your generated Database type.
 * BIGINT arguments deliberately travel as strings; PostgREST casts them to bigint.
 * Never change these to number / send raw bigint in JSON.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
type EmptySchema = {
  Tables: { [key in never]: never };
  Views: { [key in never]: never };
  Functions: { [key in never]: never };
  Enums: { [key in never]: never };
  CompositeTypes: { [key in never]: never };
};
export type RpcDatabase = {
  public: EmptySchema;
  ops: Omit<EmptySchema, 'Functions'> & {
    Functions: {
      cart_mutate_choice: {
        Args: {
          p_business_id: string;
          p_branch_id: string;
          p_check_id: string;
          p_operation_id: string;
          p_product_id: string;
          p_delta: number; p_option: string | null;
          p_expected_revision: string;
        };
        Returns: Json;
      };
      order_submit: {
        Args: {
          p_business_id: string;
          p_branch_id: string;
          p_check_id: string;
          p_operation_id: string;
          p_expected_revision: string;
        };
        Returns: Json;
      };
    };
  };
};
