window.CREATIVE_HUB_CONFIG = Object.freeze({
  supabaseUrl: 'https://ciunbeokqipnhelcivat.supabase.co',

  // Dipakai app.js versi ini
  supabaseAnonKey: 'sb_publishable_hS1nKbBk648ZxpHK4o4ydQ_pvKOtKCN',

  // Alias agar tetap kompatibel jika kode lain memakai nama baru
  supabasePublishableKey: 'sb_publishable_hS1nKbBk648ZxpHK4o4ydQ_pvKOtKCN',

  appVersion: 5,
  ownerEmail: 'maheshapanca@gmail.com',
  calendarFunctionName: 'google-calendar',

  tables: Object.freeze({
    umbrellas: 'ch_umbrellas',
    projects: 'ch_projects',
    milestones: 'ch_milestones',
    yearPlans: 'ch_year_plans',
    notes: 'ch_notes',
    settings: 'ch_settings',
    snapshots: 'ch_snapshots',
    changeLog: 'ch_change_log'
  })
});
