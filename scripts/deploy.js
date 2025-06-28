const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🚀 Starting Budzee Backend Deployment...\n');

// Check if .env file exists
if (!fs.existsSync('.env')) {
  console.error('❌ .env file not found! Please create one based on .env.example');
  process.exit(1);
}

// Check Node.js version
const nodeVersion = process.version;
console.log(`📦 Node.js version: ${nodeVersion}`);

if (parseInt(nodeVersion.slice(1)) < 18) {
  console.error('❌ Node.js 18+ is required');
  process.exit(1);
}

try {
  // Install dependencies
  console.log('📥 Installing dependencies...');
  execSync('npm ci --production', { stdio: 'inherit' });

  // Generate Prisma client
  console.log('🔧 Generating Prisma client...');
  execSync('npx prisma generate', { stdio: 'inherit' });

  // Run database migrations
  console.log('🗄️ Running database migrations...');
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });

  // Build/compile if needed
  console.log('🔨 Building application...');
  // Add any build steps here if needed

  // Test the application
  console.log('🧪 Running health check...');
  execSync('node quick-test.js', { stdio: 'inherit' });

  console.log('\n✅ Deployment completed successfully!');
  console.log('🎮 Budzee Backend is ready for production!');
  console.log('\n📋 Next steps:');
  console.log('1. Start the server: npm start');
  console.log('2. Monitor logs: tail -f logs/app.log');
  console.log('3. Check health: curl http://localhost:8080/health');

} catch (error) {
  console.error('\n❌ Deployment failed:', error.message);
  process.exit(1);
}