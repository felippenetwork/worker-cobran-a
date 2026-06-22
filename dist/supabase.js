import { createClient } from '@supabase/supabase-js';
// Cliente service role — bypassa RLS inteiramente.
// Usado exclusivamente no worker (VPS). Nunca expor para o browser.
export function createAdminClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
        throw new Error('SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios.');
    }
    return createClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
}
