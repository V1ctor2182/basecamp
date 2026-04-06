-- Run this in Supabase SQL Editor to create the required tables and storage bucket

-- Documents table (knowledge base file metadata)
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  path text unique not null,
  name text not null,
  parent_path text default '',
  type text not null check (type in ('file', 'dir')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_documents_parent on documents(parent_path);

-- GitHub tracker repos
create table if not exists repos (
  id text primary key,
  url text not null,
  owner text not null,
  repo text not null,
  added_at timestamptz default now()
);

-- Key-value config store
create table if not exists config (
  key text primary key,
  value text not null
);

-- Create storage bucket for markdown file contents
-- Note: Run this via Supabase Dashboard > Storage > New Bucket
-- Bucket name: documents
-- Public: false (private)
