import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();
const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@meridian.health';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@12345';
const DEMO_PASSWORD = 'Password@123';

const hours = (windows) =>
  windows.flatMap(({ days, start, end }) =>
    days.map((dayOfWeek) => ({ dayOfWeek, startMinute: start, endMinute: end }))
  );

const WEEKDAYS = [1, 2, 3, 4, 5];

const DOCTORS = [
  {
    fullName: 'Ananya Rao',
    email: 'ananya.rao@meridian.health',
    specialisation: 'General Medicine',
    qualification: 'MBBS, MD (Internal Medicine)',
    bio: 'Fifteen years in primary care. Special interest in diabetes and thyroid management.',
    consultationFee: 600,
    slotDurationMinutes: 20,
    bufferMinutes: 5,
    workingHours: hours([
      { days: WEEKDAYS, start: 9 * 60, end: 13 * 60 },
      { days: [1, 3, 5], start: 17 * 60, end: 20 * 60 }
    ])
  },
  {
    fullName: 'Vikram Mehta',
    email: 'vikram.mehta@meridian.health',
    specialisation: 'Cardiology',
    qualification: 'MBBS, DM (Cardiology)',
    bio: 'Interventional cardiologist. Runs the clinic\u2019s hypertension programme.',
    consultationFee: 1200,
    slotDurationMinutes: 30,
    workingHours: hours([{ days: [2, 4, 6], start: 10 * 60, end: 14 * 60 }])
  },
  {
    fullName: 'Leela Krishnan',
    email: 'leela.krishnan@meridian.health',
    specialisation: 'Dermatology',
    qualification: 'MBBS, MD (Dermatology)',
    bio: 'Treats chronic skin conditions, acne and paediatric eczema.',
    consultationFee: 800,
    slotDurationMinutes: 15,
    workingHours: hours([{ days: WEEKDAYS, start: 11 * 60, end: 16 * 60 }])
  },
  {
    fullName: 'Samuel Fernandes',
    email: 'samuel.fernandes@meridian.health',
    specialisation: 'Paediatrics',
    qualification: 'MBBS, DCH',
    bio: 'Newborn care, immunisation schedules and childhood asthma.',
    consultationFee: 700,
    slotDurationMinutes: 20,
    workingHours: hours([
      { days: [1, 2, 3, 4, 5, 6], start: 9 * 60, end: 12 * 60 },
      { days: [1, 3], start: 16 * 60, end: 19 * 60 }
    ])
  },
  {
    fullName: 'Priya Nathan',
    email: 'priya.nathan@meridian.health',
    specialisation: 'Orthopaedics',
    qualification: 'MBBS, MS (Ortho)',
    bio: 'Sports injuries, joint pain and post-operative rehabilitation.',
    consultationFee: 900,
    slotDurationMinutes: 30,
    bufferMinutes: 10,
    workingHours: hours([{ days: [1, 2, 4, 5], start: 14 * 60, end: 18 * 60 }])
  }
];

const PATIENTS = [
  { fullName: 'Rahul Sharma', email: 'rahul@example.com', phone: '+91 98400 11111' },
  { fullName: 'Meera Iyer', email: 'meera@example.com', phone: '+91 98400 22222' },
  { fullName: 'Joseph Thomas', email: 'joseph@example.com', phone: '+91 98400 33333' }
];

async function main() {
  console.log('Seeding…');

  const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const demoHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: { email: ADMIN_EMAIL, fullName: 'Clinic Administrator', role: 'ADMIN', passwordHash: adminHash },
    update: { role: 'ADMIN', passwordHash: adminHash }
  });
  console.log(`  admin      ${admin.email}`);

  for (const d of DOCTORS) {
    const { workingHours, fullName, email, ...profile } = d;
    const user = await prisma.user.upsert({
      where: { email },
      create: { email, fullName, role: 'DOCTOR', passwordHash: demoHash },
      update: { fullName, role: 'DOCTOR', passwordHash: demoHash }
    });

    const existing = await prisma.doctorProfile.findUnique({ where: { userId: user.id } });
    const doctor = existing
      ? await prisma.doctorProfile.update({ where: { id: existing.id }, data: profile })
      : await prisma.doctorProfile.create({ data: { userId: user.id, ...profile } });

    await prisma.workingHour.deleteMany({ where: { doctorId: doctor.id } });
    await prisma.workingHour.createMany({
      data: workingHours.map((w) => ({ ...w, doctorId: doctor.id }))
    });
    console.log(`  doctor     ${email} (${profile.specialisation})`);
  }

  for (const p of PATIENTS) {
    await prisma.user.upsert({
      where: { email: p.email },
      create: { ...p, role: 'PATIENT', passwordHash: demoHash },
      update: { fullName: p.fullName, passwordHash: demoHash }
    });
    console.log(`  patient    ${p.email}`);
  }

  console.log('\nDone. Sign in with:');
  console.log(`  admin    ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log(`  doctor   ananya.rao@meridian.health / ${DEMO_PASSWORD}`);
  console.log(`  patient  rahul@example.com / ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
