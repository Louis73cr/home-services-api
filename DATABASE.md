# Configuration de la Base de Données

Ce projet utilise **Prisma** avec **PostgreSQL** hébergé pour le stockage des données.

## Prérequis

- PostgreSQL 12+ installé et accessible
- Une base de données créée
- URL de connexion au format: `postgresql://user:password@host:port/database`

## Configuration locale

1. Créez un fichier `.env` à la racine du projet:
```bash
DATABASE_URL="postgresql://user:password@localhost:5432/home_services"
```

2. Installez les dépendances:
```bash
npm install
```

3. Générez le client Prisma:
```bash
npm run db:generate
```

4. Appliquez le schéma à la base de données:
```bash
npm run db:push
```

Ou créez une migration:
```bash
npm run db:migrate
```

## Configuration Cloudflare

### Workers

Définissez `DATABASE_URL` comme secret:
```bash
wrangler secret put DATABASE_URL
```

Entrez votre URL de connexion PostgreSQL quand demandé.

### Pages

1. Allez dans le dashboard Cloudflare > Pages > Votre projet > Settings
2. Cliquez sur "Environment variables"
3. Ajoutez `DATABASE_URL` comme variable d'environnement
4. Cochez "Encrypt" pour en faire un secret

## Schéma de base de données

### Table `users`

- `id` (String, Primary Key, CUID)
- `username` (String, Unique)
- `email` (String, Nullable)
- `displayName` (String, Nullable)
- `groups` (String[], Array)
- `createdAt` (DateTime)
- `updatedAt` (DateTime)

### Table `services`

- `id` (String, Primary Key, CUID)
- `name` (String)
- `redirectUrl` (String)
- `allowedGroups` (String[], Array)
- `imagePath` (String) - Chemin vers l'image dans R2
- `originalWidth` (Int, Nullable)
- `originalHeight` (Int, Nullable)
- `resizedHeight` (Int, Default: 50)
- `resizedWidth` (Int, Nullable)
- `createdAt` (DateTime)
- `updatedAt` (DateTime)

## Commandes Prisma utiles

- `npm run db:generate` - Génère le client Prisma
- `npm run db:push` - Applique le schéma sans créer de migration
- `npm run db:migrate` - Crée et applique une migration
- `npm run db:studio` - Ouvre Prisma Studio (GUI pour la base de données)

## Connexion depuis Cloudflare Workers

Le code utilise `@prisma/adapter-postgresql` et `pg` (driver PostgreSQL) pour se connecter à PostgreSQL depuis Cloudflare Workers.

Les connexions sont gérées via un pool de connexions avec une limite de 1 connexion pour éviter les problèmes dans l'environnement serverless de Cloudflare Workers.

## Sécurité

⚠️ **Important**: Ne commitez jamais votre `DATABASE_URL` dans le dépôt Git. Utilisez toujours les secrets Cloudflare pour la production.

- Ajoutez `.env` à `.gitignore`
- Utilisez `wrangler secret put DATABASE_URL` pour définir les secrets en production
- Configurez des règles de pare-feu PostgreSQL pour limiter l'accès aux IPs Cloudflare si possible

