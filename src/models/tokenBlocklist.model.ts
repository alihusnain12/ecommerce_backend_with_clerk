import mongoose from 'mongoose';

interface ITokenBlocklist {
   token: string;
}

const tokenBlocklistSchema = new mongoose.Schema<ITokenBlocklist>(
   {
      token: {
         type: String,
         required: [true, 'Token is required to add in the blocklist'],
         unique: true,
      },
   },
   { timestamps: true }
);

const TokenBlocklist = mongoose.model<ITokenBlocklist>(
   'TokenBlocklist',
   tokenBlocklistSchema
);

export default TokenBlocklist;
