use async_trait::async_trait;
use std::{collections::BTreeMap, convert::Infallible, sync::Mutex};
use zcash_client_backend::{
    data_api::{
        chain::{BlockCache, BlockSource, error},
        scanning::ScanRange,
    },
    proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

#[derive(Default)]
pub struct Cache(Mutex<BTreeMap<u32, CompactBlock>>);
impl BlockSource for Cache {
    type Error = Infallible;
    fn with_blocks<F, E>(
        &self,
        from: Option<BlockHeight>,
        limit: Option<usize>,
        mut f: F,
    ) -> Result<(), error::Error<E, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), error::Error<E, Self::Error>>,
    {
        for (_, b) in self
            .0
            .lock()
            .unwrap()
            .range(u32::from(from.unwrap_or(0.into()))..)
            .take(limit.unwrap_or(usize::MAX))
        {
            f(b.clone())?;
        }
        Ok(())
    }
}
#[async_trait]
impl BlockCache for Cache {
    fn get_tip_height(
        &self,
        range: Option<&ScanRange>,
    ) -> Result<Option<BlockHeight>, Self::Error> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .keys()
            .rev()
            .find(|h| range.is_none_or(|r| r.block_range().contains(&BlockHeight::from_u32(**h))))
            .map(|h| (*h).into()))
    }
    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(h, _)| range.block_range().contains(&BlockHeight::from_u32(**h)))
            .map(|(_, b)| b.clone())
            .collect())
    }
    async fn insert(&self, blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        let mut cache = self.0.lock().unwrap();
        for b in blocks {
            cache.insert(u32::try_from(b.height).expect("height fits u32"), b);
        }
        Ok(())
    }
    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        self.0
            .lock()
            .unwrap()
            .retain(|h, _| !range.block_range().contains(&(*h).into()));
        Ok(())
    }
}
